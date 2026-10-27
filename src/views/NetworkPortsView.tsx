import React, { useState, useEffect, useCallback } from 'react';
import { ServerInstance } from '../types';

interface NetworkPortsViewProps {
  server: ServerInstance;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

interface HostInterfaceInfo {
  name: string;
  address: string;
  family: string;
  mac: string;
  internal: boolean;
}

interface ProbeResult {
  reachable: boolean;
  latencyMs: number;
  checkedAt: string;
}

/** Evidence read back from the OS after an apply. */
interface ProbeVerification {
  firewall: boolean;
  portProxy: boolean;
  portProxyRequired: boolean;
  checkedAt: string;
  detail?: string;
}

/** One step of the elevated-apply self-test, as the backend reported it. */
interface SelfTestStage {
  name: 'apply' | 'revert';
  ok: boolean;
  code?: string;
  message: string;
  verification?: ProbeVerification | null;
}

/**
 * The self-test result. `proven` is false for every failure, including a declined
 * UAC prompt, so a green badge can never appear without a confirmed apply.
 */
interface SelfTestReport {
  ok: boolean;
  proven: boolean;
  cleanup?: 'clean' | 'leftover' | 'nothing-to-clean';
  port?: number;
  stages: SelfTestStage[];
  code?: string;
  error?: string;
  detail?: string;
  message?: string;
  cleanupCommands?: { firewall: string; portProxy: string };
}

/**
 * A rule as the backend stores it. `ACTIVE` is only ever set after the backend
 * has read the mapping back out of netsh, so this view may trust it; every
 * other status means the mapping is not live on this PC.
 */
interface ForwardRule {
  id: string;
  externalPort: number;
  internalPort: number;
  internalIp: string;
  protocol: 'TCP' | 'UDP' | 'TCP/UDP';
  serviceName: string;
  method: 'UPnP IGDv2' | 'Netsh PortProxy' | 'Playit.gg Tunnel' | 'Cloudflare Spectrum';
  status: 'RECORDED' | 'APPLYING' | 'ACTIVE' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
  applyError?: string | null;
  verification?: ProbeVerification | null;
  lastProbe?: ProbeResult;
  /** Live local-side probe, recomputed by the backend on every scan. */
  liveProbe?: ProbeResult;
}

interface ScannedLocalPort {
  port: number;
  proto: 'TCP' | 'UDP';
  bindAddress: string;
  processName: string;
  pid: number;
  serviceDescription: string;
  sourceType: 'OS_KERNEL_LIVE' | 'PANEL_MANAGED';
  reachable: boolean;
  latencyMs: number;
  forwarded: boolean;
  forwardConfig: ForwardRule | null;
}

export const NetworkPortsView: React.FC<NetworkPortsViewProps> = ({ server, onShowToast }) => {
  const [filterCat, setFilterCat] = useState<'all' | 'TCP/UDP' | 'TCP' | 'UDP'>('all');

  // Real-Time Local PC Port & Network Scanner State
  const [hostInterfaces, setHostInterfaces] = useState<HostInterfaceInfo[]>([]);
  const [scannedPorts, setScannedPorts] = useState<ScannedLocalPort[]>([]);
  // The rule list is owned by the backend so it survives a restart and every
  // view (Advanced + Simple) reads the same data.
  const [forwardRules, setForwardRules] = useState<ForwardRule[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string>('');
  const [hostPlatform, setHostPlatform] = useState<string>('');
  const [lastScannedAt, setLastScannedAt] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [autoPollEnabled, setAutoPollEnabled] = useState<boolean>(true);
  const [removingPort, setRemovingPort] = useState<number | null>(null);
  const [ruleAction, setRuleAction] = useState<{
    port: number;
    action: 'apply' | 'verify' | 'revert';
  } | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);

  // Port Forwarding Setup Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [newServiceName, setNewServiceName] = useState('');
  const [newInternalPort, setNewInternalPort] = useState('25565');
  const [newExternalPort, setNewExternalPort] = useState('25565');
  const [newInternalIp, setNewInternalIp] = useState('127.0.0.1');
  const [newProto, setNewProto] = useState<'TCP' | 'UDP' | 'TCP/UDP'>('TCP/UDP');
  const [newForwardMethod, setNewForwardMethod] = useState<
    'UPnP IGDv2' | 'Netsh PortProxy' | 'Playit.gg Tunnel' | 'Cloudflare Spectrum'
  >('UPnP IGDv2');
  const [generatedCommands, setGeneratedCommands] = useState<{
    netsh: string;
    powershellFirewall: string;
    upnpCli: string;
  } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSavingRule, setIsSavingRule] = useState(false);

  const fetchLocalPcPorts = useCallback(
    async (silent = false) => {
      if (!silent) setIsScanning(true);
      try {
        const qs = new URLSearchParams({
          serverId: server.id,
          serverPort: String(server.port || 25565),
          serverName: server.name,
          serverEngine: server.engine,
          serverPid: String(server.pid || 0),
        });
        const resp = await fetch(`/api/network/local-ports?${qs.toString()}`);
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.ok) {
          setScanError(
            data?.error || `The backend refused the port scan (HTTP ${resp.status}).`,
          );
          return;
        }
        setHostInterfaces(data.interfaces || []);
        setScannedPorts(data.ports || []);
        setForwardRules(Array.isArray(data.forwards) ? data.forwards : []);
        setHostName(data.hostname || '');
        setHostPlatform(data.platform || '');
        setLastScannedAt(new Date(data.scannedAt || Date.now()).toLocaleTimeString());
        setScanError(null);
      } catch {
        // A dead backend must not leave a stale scan on screen looking live.
        setScanError('Could not reach the local backend to scan ports.');
      } finally {
        if (!silent) setIsScanning(false);
      }
    },
    [server.id, server.port, server.name, server.engine, server.pid],
  );

  useEffect(() => {
    fetchLocalPcPorts(false);
  }, [fetchLocalPcPorts]);

  useEffect(() => {
    if (!autoPollEnabled) return;
    const interval = setInterval(() => {
      fetchLocalPcPorts(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoPollEnabled, fetchLocalPcPorts]);

  const serverRules = forwardRules.filter((rule) => rule.internalPort === server.port);
  const filteredRules = serverRules.filter((rule) =>
    filterCat === 'all' ? true : rule.protocol === filterCat,
  );
  const listeningCount = scannedPorts.filter((port) => port.reachable).length;

  const handleCopyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    onShowToast(`${label} Copied`, text, 'success', 'content_copy');
  };

  const openForwardModalForPort = (portItem?: ScannedLocalPort) => {
    if (portItem) {
      setNewServiceName(portItem.serviceDescription);
      setNewInternalPort(String(portItem.port));
      setNewExternalPort(String(portItem.forwardConfig?.externalPort || portItem.port));
      setNewInternalIp(portItem.forwardConfig?.internalIp || '127.0.0.1');
      setNewProto(
        portItem.forwardConfig?.protocol || (portItem.proto === 'UDP' ? 'UDP' : 'TCP/UDP'),
      );
      setNewForwardMethod(portItem.forwardConfig?.method || 'UPnP IGDv2');
    } else {
      setNewServiceName(`${server.name} Custom Port`);
      setNewInternalPort(String(server.port));
      setNewExternalPort(String(server.port));
      setNewInternalIp('127.0.0.1');
      setNewProto('TCP/UDP');
      setNewForwardMethod('UPnP IGDv2');
    }
    setGeneratedCommands(null);
    setModalError(null);
    setModalOpen(true);
  };

  const handleCreatePort = async (e: React.FormEvent) => {
    e.preventDefault();
    const intNum = Number.parseInt(newInternalPort, 10);
    const extNum = Number.parseInt(newExternalPort, 10);

    const portProblem =
      !Number.isInteger(intNum) || intNum < 1 || intNum > 65535
        ? 'The local port must be a whole number between 1 and 65535.'
        : !Number.isInteger(extNum) || extNum < 1 || extNum > 65535
          ? 'The external port must be a whole number between 1 and 65535.'
          : !/^(\d{1,3}\.){3}\d{1,3}$/.test(newInternalIp.trim())
            ? 'The local bind IP must be an IPv4 address such as 127.0.0.1.'
            : null;
    if (portProblem) {
      setModalError(portProblem);
      return;
    }

    setIsSavingRule(true);
    setModalError(null);
    try {
      const resp = await fetch('/api/network/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalPort: extNum,
          internalPort: intNum,
          internalIp: newInternalIp.trim(),
          protocol: newProto,
          serviceName: newServiceName.trim() || `${server.name} Game Port :${intNum}`,
          method: newForwardMethod,
        }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        const message = data?.error || `The backend refused the rule (HTTP ${resp.status}).`;
        setModalError(message);
        onShowToast('Rule not saved', message, 'error', 'error');
        return;
      }

      // The rule shown afterwards is the one the backend stored — never a local copy.
      setGeneratedCommands(data.commands || null);
      await fetchLocalPcPorts(true);
      onShowToast(
        `Rule recorded for :${data.rule?.externalPort ?? extNum}`,
        data.probeReachable
          ? 'Saved on this panel and the local port is listening. Nothing was applied to your router or firewall — run the command below to finish.'
          : 'Saved on this panel. Nothing is listening on that local port yet, and nothing was applied to your router or firewall.',
        data.probeReachable ? 'info' : 'warning',
        'save',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backend unreachable';
      setModalError(message);
      onShowToast('Rule not saved', message, 'error', 'error');
    } finally {
      setIsSavingRule(false);
    }
  };

  /**
   * Apply / verify / revert all go through the backend, which owns the elevation
   * and the read-back. The UI only ever repeats what the backend confirmed.
   */
  const runRuleAction = async (
    rule: ForwardRule,
    action: 'apply' | 'verify' | 'revert',
  ) => {
    if (action === 'apply') {
      const confirmed = window.confirm(
        `Apply port ${rule.externalPort} → ${rule.internalIp}:${rule.internalPort} on this PC?\n\nWindows will ask for administrator approval. This adds a netsh portproxy entry and an inbound firewall rule for port ${rule.externalPort}.`,
      );
      if (!confirmed) return;
    }
    if (action === 'revert') {
      const confirmed = window.confirm(
        `Remove the Windows firewall rule and portproxy entry for port ${rule.externalPort}?\n\nThe rule stays recorded in this panel.`,
      );
      if (!confirmed) return;
    }

    setRuleAction({ port: rule.externalPort, action });
    try {
      const resp = await fetch(`/api/network/forward/${rule.externalPort}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await resp.json().catch(() => null);

      if (action === 'verify' && resp.ok && data?.ok) {
        onShowToast(
          data.verified
            ? `Mapping verified for :${rule.externalPort}`
            : `Mapping not found for :${rule.externalPort}`,
          data.verified
            ? 'The firewall rule and portproxy entry are present on this PC.'
            : data.verification?.detail ||
                'Nothing in the OS matches this rule, so it is no longer shown as active.',
          data.verified ? 'success' : 'warning',
          'verified',
        );
        await fetchLocalPcPorts(true);
        return;
      }

      if (!resp.ok || !data?.ok) {
        const message = data?.error || `The backend refused the request (HTTP ${resp.status}).`;
        onShowToast(
          action === 'apply' ? 'Apply failed' : action === 'revert' ? 'Revert failed' : 'Check failed',
          data?.detail ? `${message} ${data.detail}` : message,
          'error',
          'error',
        );
        // A failed apply/verify may have changed the stored status (FAILED /
        // downgraded), so re-read it instead of guessing.
        await fetchLocalPcPorts(true);
        return;
      }

      onShowToast(
        action === 'apply'
          ? `Port ${rule.externalPort} is live on this PC`
          : `Port ${rule.externalPort} is closed again`,
        action === 'apply'
          ? 'Windows confirmed the firewall rule and portproxy entry. If this PC is behind NAT, your router still has to forward the port.'
          : 'The firewall rule and portproxy entry are gone. The rule is still recorded here.',
        'success',
        action === 'apply' ? 'router' : 'link_off',
      );
      await fetchLocalPcPorts(true);
    } catch (err) {
      onShowToast(
        action === 'apply' ? 'Apply failed' : 'Request failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    } finally {
      setRuleAction(null);
    }
  };

  /**
   * Proves the elevated path on THIS PC: apply a throwaway mapping on a free
   * high port and remove it again. No rule is recorded, and both stages are
   * reported exactly as the backend observed them.
   */
  const runElevationSelfTest = async () => {
    const confirmed = window.confirm(
      'Run the elevated apply test?\n\nWindows will ask for administrator approval twice: once to add a throwaway portproxy entry and firewall rule on a random free port (49152-65535), and once to remove them again. No rule is saved and no game port is touched.',
    );
    if (!confirmed) return;

    setSelfTestRunning(true);
    setSelfTest(null);
    try {
      const resp = await fetch('/api/network/forward/self-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = (await resp.json().catch(() => null)) as SelfTestReport | null;
      const report: SelfTestReport = data
        ? { ...data, stages: Array.isArray(data.stages) ? data.stages : [] }
        : {
            ok: false,
            proven: false,
            stages: [],
            error: `The backend refused the self-test (HTTP ${resp.status}).`,
          };
      setSelfTest(report);

      if (report.proven && report.cleanup === 'clean') {
        onShowToast(
          'Elevated apply verified',
          report.message ||
            `Windows accepted a portproxy entry and firewall rule for :${report.port} and removed them again.`,
          'success',
          'verified',
        );
      } else if (report.proven && report.cleanup === 'leftover') {
        onShowToast(
          'Mapping left behind',
          report.error ||
            'The throwaway mapping could not be removed. Use the cleanup commands shown here.',
          'error',
          'error',
        );
      } else {
        onShowToast(
          'Elevation test failed',
          [report.error, report.detail].filter(Boolean).join(' ') ||
            'Nothing was changed on this PC.',
          'error',
          'error',
        );
      }
      await fetchLocalPcPorts(true);
    } catch (err) {
      setSelfTest({
        ok: false,
        proven: false,
        stages: [],
        error: err instanceof Error ? err.message : 'Backend unreachable',
      });
      onShowToast(
        'Elevation test failed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    } finally {
      setSelfTestRunning(false);
    }
  };

  const statusChip = (rule: ForwardRule) => {
    switch (rule.status) {
      case 'ACTIVE':
        return {
          label: 'ACTIVE',
          note: 'verified on this PC',
          dot: 'bg-secondary',
          text: 'text-secondary',
        };
      case 'APPLYING':
        return {
          label: 'APPLYING',
          note: 'waiting for Windows',
          dot: 'bg-primary',
          text: 'text-primary',
        };
      case 'FAILED':
        return { label: 'FAILED', note: 'not applied', dot: 'bg-error', text: 'text-error' };
      default:
        return {
          label: 'RECORDED',
          note: 'not applied to this PC',
          dot: 'bg-amber-300',
          text: 'text-amber-300',
        };
    }
  };

  const handleRemoveForward = async (portNum: number) => {
    if (
      !window.confirm(
        `Remove the recorded forward rule for port ${portNum}?\n\nThis only removes the rule from this panel. Router or firewall entries you created stay in place.`,
      )
    ) {
      return;
    }
    setRemovingPort(portNum);
    try {
      const resp = await fetch(`/api/network/forward/${portNum}`, { method: 'DELETE' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        onShowToast(
          'Rule not removed',
          data?.error || `The backend refused the request (HTTP ${resp.status}).`,
          'error',
          'error',
        );
        return;
      }
      onShowToast(
        `Rule removed for :${portNum}`,
        'The panel no longer tracks this mapping. Router or firewall entries are untouched.',
        'info',
        'link_off',
      );
      await fetchLocalPcPorts(true);
    } catch (err) {
      onShowToast(
        'Rule not removed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
        'error',
      );
    } finally {
      setRemovingPort(null);
    }
  };

  // netsh portproxy + Windows Firewall only exist on Windows. Say so instead of
  // offering a button that can only fail.
  const selfTestUnsupported = Boolean(hostPlatform) && !hostPlatform.toLowerCase().startsWith('win');

  const selfTestLook = (report: SelfTestReport) => {
    if (report.proven && report.cleanup === 'clean') {
      return {
        label: 'PROVEN · CLEANED UP',
        icon: 'verified',
        cls: 'border-secondary/30 bg-secondary/10 text-secondary',
      };
    }
    if (report.proven && report.cleanup === 'leftover') {
      return {
        label: 'PROVEN · MAPPING LEFT BEHIND',
        icon: 'warning',
        cls: 'border-error/40 bg-error/10 text-error',
      };
    }
    return {
      label: 'NOT PROVEN',
      icon: 'error',
      cls: 'border-amber-300/30 bg-amber-300/10 text-amber-300',
    };
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* ================= SUB-HEADER / INSTANCE NETWORK STATUS ================= */}
      <div className="rounded-xl bg-surface border border-white/[0.06] px-4 py-3">
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[17px] text-primary">hub</span>
              <h1 className="text-[14.5px] font-semibold text-on-surface whitespace-nowrap">Network</h1>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
                <span className="size-1.5 rounded-full bg-secondary" />
                {listeningCount} listening
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5 font-mono text-[11px] text-outline">
              <span className="text-on-surface">{server.name}</span>
              <span className="text-white/15">|</span>
              <span>{hostName ? `${hostName} · ${hostPlatform}` : 'Host not scanned yet'}</span>
            </div>
          </div>

          {/* Action Cluster */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setScanError(null);
                void fetchLocalPcPorts(false);
              }}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
            >
              <span className={`material-symbols-outlined text-[16px] ${isScanning ? 'animate-spin' : ''}`}>
                sync
              </span>
              <span>Scan ports</span>
            </button>

            <button
              type="button"
              onClick={() => setAutoPollEnabled((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border font-mono text-[11px] transition-colors cursor-pointer ${
                autoPollEnabled
                  ? 'bg-secondary/10 text-secondary border-secondary/25'
                  : 'bg-white/[0.02] text-outline border-white/10'
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${
                  autoPollEnabled ? 'bg-secondary' : 'bg-outline'
                }`}
              />
              <span>{autoPollEnabled ? 'Polling 5s' : 'Poll paused'}</span>
            </button>

            <button
              type="button"
              onClick={() => void runElevationSelfTest()}
              disabled={selfTestRunning || selfTestUnsupported}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors disabled:opacity-50 cursor-pointer"
              title={
                selfTestUnsupported
                  ? 'The elevated netsh apply is only implemented on Windows — this host is not supported'
                  : 'Apply and immediately revert a throwaway mapping on a free high port — proves the elevated netsh path on this PC'
              }
            >
              <span
                className={`material-symbols-outlined text-[16px] ${
                  selfTestRunning ? 'animate-spin' : ''
                }`}
              >
                {selfTestRunning ? 'progress_activity' : 'science'}
              </span>
              <span>{selfTestRunning ? 'Testing…' : 'Test elevated apply'}</span>
            </button>

            <button
              type="button"
              onClick={() => openForwardModalForPort()}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-[11.5px] font-semibold text-on-primary transition-all cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Port forward rule
            </button>
          </div>
        </div>

        {/* Live Host Network Interfaces Strip */}
        <div className="mt-4 pt-4 border-t border-white/[0.08] flex flex-wrap items-center gap-2 font-code-sm text-code-sm">
          <span className="text-outline uppercase font-bold text-[10px]">
            Local PC NIC Interfaces:
          </span>
          {hostInterfaces.map((iface, idx) => (
            <div
              key={`${iface.name}-${iface.address}-${idx}`}
              className="flex items-center gap-1.5 bg-surface-container px-2.5 py-1 rounded-md border border-white/[0.06]"
            >
              <span
                className={`size-1.5 rounded-full ${
                  iface.internal ? 'bg-tertiary' : 'bg-secondary'
                }`}
              />
              <span className="text-white font-semibold">{iface.name}</span>
              <span className="text-primary font-mono">{iface.address}</span>
              <span className="text-outline text-[10px]">({iface.family})</span>
            </div>
          ))}
          {lastScannedAt && (
            <span className="ml-auto text-outline text-[11px]">
              Last OS Kernel Scan: <strong className="text-secondary">{lastScannedAt}</strong>
            </span>
          )}
        </div>
      </div>

      {selfTest &&
        (() => {
          const look = selfTestLook(selfTest);
          return (
            <div className="rounded-xl bg-surface-container-low border border-white/[0.08] px-4 py-3 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[17px] text-outline">science</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[12.5px] font-semibold text-on-surface">
                      Elevated apply self-test
                    </h2>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-mono text-[10px] font-bold ${look.cls}`}
                    >
                      <span className="material-symbols-outlined text-[13px]">{look.icon}</span>
                      {look.label}
                    </span>
                    {selfTest.port !== undefined && (
                      <span className="font-mono text-[10.5px] text-outline">
                        throwaway port :{selfTest.port} → 127.0.0.1:{selfTest.port}
                      </span>
                    )}
                  </div>

                  {selfTest.stages.length > 0 && (
                    <ol className="mt-1.5 space-y-1">
                      {selfTest.stages.map((stage) => (
                        <li
                          key={stage.name}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]"
                        >
                          <span
                            className={`inline-flex items-center gap-1 font-bold ${
                              stage.ok ? 'text-secondary' : 'text-error'
                            }`}
                          >
                            <span className="material-symbols-outlined text-[13px]">
                              {stage.ok ? 'check_circle' : 'cancel'}
                            </span>
                            {stage.name === 'apply' ? '1 · apply' : '2 · revert'}
                          </span>
                          <span className="text-on-surface-variant min-w-0">
                            {stage.message}
                            {stage.code ? ` [${stage.code}]` : ''}
                          </span>
                          {stage.verification && (
                            <span className="text-outline">
                              portproxy{' '}
                              {stage.verification.portProxyRequired
                                ? stage.verification.portProxy
                                  ? '✓'
                                  : '✗'
                                : 'n/a (UDP)'}{' '}
                              · firewall {stage.verification.firewall ? '✓' : '✗'}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  {(() => {
                    // The stage rows already carry each failure's own message, so
                    // the summary only appears when it adds something.
                    const stageText = selfTest.stages.map((stage) => stage.message).join(' ');
                    const errorText =
                      selfTest.error && !stageText.includes(selfTest.error)
                        ? selfTest.error
                        : null;
                    const detailText = selfTest.detail || null;
                    if (!errorText && !detailText) return null;
                    return (
                      <p className="mt-1.5 font-mono text-[11px] text-on-surface-variant">
                        {[errorText, detailText].filter(Boolean).join(' ')}
                      </p>
                    );
                  })()}

                  {selfTest.cleanupCommands && (
                    <div className="mt-2 rounded-lg border border-error/30 bg-error/5 p-2.5">
                      <p className="font-mono text-[10.5px] text-error font-bold uppercase">
                        Remove the leftover mapping by hand
                      </p>
                      <p className="mt-1 font-mono text-[10.5px] text-on-surface-variant break-all">
                        {selfTest.cleanupCommands.firewall}
                      </p>
                      <p className="font-mono text-[10.5px] text-on-surface-variant break-all">
                        {selfTest.cleanupCommands.portProxy}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          handleCopyText(
                            `${selfTest.cleanupCommands?.firewall}\n${selfTest.cleanupCommands?.portProxy}`,
                            'Cleanup commands',
                          )
                        }
                        className="mt-1.5 inline-flex items-center gap-1 h-6 px-2 rounded-md border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[10.5px] text-on-surface cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[13px]">content_copy</span>
                        Copy
                      </button>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSelfTest(null)}
                  className="p-1 rounded-md hover:bg-white/[0.06] text-outline cursor-pointer"
                  title="Dismiss the self-test result"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>
          );
        })()}

      {scanError && (
        <div className="rounded-xl border border-error/40 bg-error/10 px-4 py-3 flex items-start gap-2.5">
          <span className="material-symbols-outlined text-[17px] text-error">error</span>
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-error">Port scan failed</p>
            <p className="font-mono text-[11px] text-on-surface-variant mt-0.5">{scanError}</p>
            <p className="font-mono text-[11px] text-outline mt-1">
              Anything below is from the last successful scan and may be out of date.
            </p>
          </div>
        </div>
      )}

      {/* ================= REAL-TIME LOCAL PC PORTS & FORWARDING SETUP MATRIX ================= */}
      <div className="rounded-xl bg-surface-container-low border border-white/[0.08] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-white flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] text-outline">terminal</span>
              Active local ports
              <span className="px-1.5 py-0.5 rounded bg-white/[0.05] font-mono text-[10px] text-outline">
                {scannedPorts.length}
              </span>
            </h2>
            <p className="font-mono text-[11px] text-outline mt-0.5">
              Live kernel sockets with direct UPnP / netsh / tunnel forwarding
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left font-body-sm text-body-sm">
            <thead>
              <tr className="bg-surface-container text-outline font-label-caps text-label-caps uppercase">
                <th className="py-2.5 px-3 rounded-l-lg">Local Port</th>
                <th className="py-2.5 px-3">Bind Address</th>
                <th className="py-2.5 px-3">Process &amp; PID</th>
                <th className="py-2.5 px-3">Server / Service</th>
                <th className="py-2.5 px-3">Source &amp; Probe</th>
                <th className="py-2.5 px-3">Forwarding Status</th>
                <th className="py-2.5 px-3 text-right rounded-r-lg">Forwarding Setup</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-container">
              {scannedPorts.map((sp) => (
                <tr
                  key={`${sp.proto}-${sp.port}`}
                  className="hover:bg-surface-container/60 transition-colors"
                >
                  <td className="py-3 px-3 font-mono">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-1 rounded font-bold text-xs ${
                          sp.port === server.port
                            ? 'bg-primary text-on-primary'
                            : sp.sourceType === 'OS_KERNEL_LIVE'
                              ? 'bg-secondary/20 text-secondary'
                              : 'bg-surface-container-high text-white'
                        }`}
                      >
                        :{sp.port}
                      </span>
                      <span className="text-on-surface-variant text-xs">{sp.proto}</span>
                    </div>
                  </td>

                  <td className="py-3 px-3 font-mono text-xs text-on-surface">
                    {sp.bindAddress}:{sp.port}
                  </td>

                  <td className="py-3 px-3 font-mono text-xs">
                    <span className="text-white font-semibold">{sp.processName}</span>
                    <span className="text-outline ml-1.5">(PID {sp.pid})</span>
                  </td>

                  <td className="py-3 px-3">
                    <span className="text-on-surface font-medium">{sp.serviceDescription}</span>
                  </td>

                  <td className="py-3 px-3 font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          sp.sourceType === 'OS_KERNEL_LIVE'
                            ? 'bg-secondary/15 text-secondary'
                            : 'bg-tertiary/15 text-tertiary'
                        }`}
                      >
                        {sp.sourceType === 'OS_KERNEL_LIVE' ? 'OS KERNEL LIVE' : 'MANAGED NODE'}
                      </span>
                      <span className="text-outline">{sp.latencyMs}ms</span>
                    </div>
                  </td>

                  <td className="py-3 px-3">
                    {sp.forwarded && sp.forwardConfig ? (
                      <div className="flex flex-col">
                        <span
                          className={`font-mono text-xs font-bold flex items-center gap-1 ${
                            sp.forwardConfig.status === 'ACTIVE'
                              ? 'text-secondary'
                              : 'text-amber-300'
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              sp.forwardConfig.status === 'ACTIVE'
                                ? 'bg-secondary'
                                : 'bg-amber-300'
                            }`}
                          />
                          {sp.forwardConfig.status === 'ACTIVE'
                            ? `:${sp.forwardConfig.externalPort} active (verified)`
                            : `Rule :${sp.forwardConfig.externalPort} recorded`}
                        </span>
                        <span className="text-[10px] font-mono text-outline">
                          → {sp.forwardConfig.internalIp}:{sp.forwardConfig.internalPort} ·
                          {sp.forwardConfig.status === 'ACTIVE'
                            ? ' firewall + portproxy present'
                            : ' not applied to this PC'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-outline font-mono text-xs">No rule recorded</span>
                    )}
                  </td>

                  <td className="py-3 px-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => openForwardModalForPort(sp)}
                        className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                          sp.forwarded
                            ? 'border-primary/25 bg-primary/10 text-primary hover:bg-primary/20'
                            : 'border-white/10 bg-white/[0.02] text-on-surface hover:bg-white/[0.06]'
                        }`}
                      >
                        <span className="material-symbols-outlined text-sm">
                          {sp.forwarded ? 'tune' : 'call_split'}
                        </span>
                        <span>{sp.forwarded ? 'Edit Forward' : 'Setup Forward'}</span>
                      </button>

                      {sp.forwarded && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleRemoveForward(sp.forwardConfig?.externalPort ?? sp.port)
                          }
                          disabled={removingPort !== null}
                          className="p-1 rounded-md bg-error/15 hover:bg-error/30 text-error disabled:opacity-40 cursor-pointer"
                          title="Remove the recorded rule from this panel"
                        >
                          <span className="material-symbols-outlined text-sm">link_off</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ================= DUAL COLUMN ARCHITECTURE ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT / MAIN DECK (8 COLS) */}
        <div className="lg:col-span-8 flex flex-col space-y-6">
          {/* ACTIVE PORT FORWARDING MATRIX (DATA TABLE) */}
          <div className="rounded-xl bg-surface-container-low border border-white/[0.08] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold text-white flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-outline">dns</span>
                  Recorded forward rules
                  <span className="px-1.5 py-0.5 rounded bg-white/[0.05] font-mono text-[10px] text-outline">
                    {serverRules.length}
                  </span>
                </h2>
                <p className="font-mono text-[11px] text-outline mt-0.5 truncate">
                  Saved by the panel for {server.name} · applied by you
                </p>
              </div>

              <div className="flex items-center gap-0.5 self-start sm:self-auto rounded-lg p-0.5 border border-white/10">
                {[
                  { id: 'all', label: `All (${serverRules.length})` },
                  { id: 'TCP/UDP', label: 'TCP/UDP' },
                  { id: 'TCP', label: 'TCP' },
                  { id: 'UDP', label: 'UDP' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFilterCat(tab.id as typeof filterCat)}
                    className={`h-7 px-2.5 rounded-md font-mono text-[11px] transition-colors cursor-pointer ${
                      filterCat === tab.id
                        ? 'bg-white/10 text-white font-semibold'
                        : 'text-outline hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left font-body-sm text-body-sm">
                <thead>
                  <tr className="bg-surface-container text-outline font-label-caps text-label-caps uppercase">
                    <th className="py-2.5 px-3 rounded-l-lg">Port / Proto</th>
                    <th className="py-2.5 px-3">Service &amp; Target</th>
                    <th className="py-2.5 px-3">Method</th>
                    <th className="py-2.5 px-3">Local listener</th>
                    <th className="py-2.5 px-3">Panel status</th>
                    <th className="py-2.5 px-3 text-right rounded-r-lg">Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container">
                  {filteredRules.map((rule) => {
                    const chip = statusChip(rule);
                    const busy = ruleAction?.port === rule.externalPort;
                    return (
                    <tr key={rule.id} className="group hover:bg-surface-container/60 transition-colors">
                      <td className="py-3 px-3 font-code-md text-code-md">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 rounded font-bold font-mono bg-primary/20 text-primary">
                            {rule.externalPort}
                          </span>
                          <span className="text-on-surface-variant text-xs">{rule.protocol}</span>
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <div className="flex flex-col">
                          <span className="font-body-md text-body-md text-on-surface font-semibold">
                            {rule.serviceName}
                          </span>
                          <span className="font-code-sm text-code-sm text-on-surface-variant">
                            {rule.internalIp}:{rule.internalPort}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <span className="inline-flex items-center gap-1 font-code-sm text-code-sm text-on-surface-variant">
                          <span className="material-symbols-outlined text-xs">sync</span>
                          {rule.method}
                        </span>
                      </td>

                      <td className="py-3 px-3 font-code-sm text-code-sm">
                        <div className="flex flex-col">
                          <span
                            className={
                              rule.liveProbe?.reachable
                                ? 'text-secondary font-mono'
                                : 'text-outline font-mono'
                            }
                          >
                            {rule.liveProbe?.reachable ? 'listening' : 'not listening'}
                          </span>
                          <span className="text-[10px] font-mono text-outline">
                            {rule.lastProbe
                              ? `probed ${new Date(rule.lastProbe.checkedAt).toLocaleTimeString()}`
                              : 'never probed'}
                          </span>
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <div className="flex flex-col gap-0.5">
                          <span
                            className={`font-bold font-code-sm text-code-sm flex items-center gap-1.5 ${chip.text}`}
                          >
                            <span className={`size-2 rounded-full ${chip.dot}`} />
                            {chip.label}
                          </span>
                          {rule.status === 'FAILED' && rule.applyError ? (
                            <span
                              className="text-[10px] font-mono text-error/90 max-w-[220px] truncate"
                              title={rule.applyError}
                            >
                              {rule.applyError}
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono text-outline">{chip.note}</span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-3 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {rule.status === 'ACTIVE' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void runRuleAction(rule, 'verify')}
                                disabled={busy}
                                className="inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[10.5px] font-medium text-on-surface disabled:opacity-40 cursor-pointer"
                                title="Re-read netsh and confirm the mapping is still there"
                              >
                                <span className="material-symbols-outlined text-[14px]">
                                  verified
                                </span>
                                {busy && ruleAction?.action === 'verify' ? 'Checking…' : 'Verify'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void runRuleAction(rule, 'revert')}
                                disabled={busy}
                                className="inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-error/30 bg-error/10 hover:bg-error/20 text-[10.5px] font-medium text-error disabled:opacity-40 cursor-pointer"
                                title="Remove the firewall rule and portproxy entry — Windows asks for approval"
                              >
                                <span className="material-symbols-outlined text-[14px]">
                                  link_off
                                </span>
                                {busy && ruleAction?.action === 'revert' ? 'Reverting…' : 'Revert'}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void runRuleAction(rule, 'apply')}
                              disabled={busy || rule.status === 'APPLYING'}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-primary/30 bg-primary/10 hover:bg-primary/20 text-[10.5px] font-semibold text-primary disabled:opacity-40 cursor-pointer"
                              title="Apply on this PC — Windows asks for administrator approval"
                            >
                              <span className="material-symbols-outlined text-[14px]">bolt</span>
                              {busy ? 'Applying…' : 'Apply'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleRemoveForward(rule.externalPort)}
                            disabled={removingPort !== null || busy}
                            className="p-1.5 rounded-md hover:bg-error-container text-error disabled:opacity-40 transition-colors cursor-pointer"
                            title="Remove this rule from the panel"
                          >
                            <span className="material-symbols-outlined text-base">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                  {filteredRules.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-6 px-3 text-center font-mono text-xs text-outline"
                      >
                        {serverRules.length === 0
                          ? `No forward rule is recorded for port ${server.port}. Use "Port forward rule" above to add one.`
                          : 'No rule matches this protocol filter.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* TUNNELS — NOT IMPLEMENTED. Stated plainly instead of showing fake daemons. */}
          <div className="rounded-xl bg-surface-container-low border border-white/[0.08] p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-surface-container text-outline">
                <span className="material-symbols-outlined text-xl">vpn_lock</span>
              </div>
              <div>
                <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                  Tunnels &amp; CGNAT bypass
                </h2>
                <p className="font-code-sm text-code-sm text-on-surface-variant">
                  Not provided by this panel
                </p>
              </div>
            </div>
            <p className="font-mono text-[11px] text-outline leading-relaxed">
              No tunnel client (playit.gg, Cloudflare Spectrum or similar) is installed or driven by
              this panel, so it cannot publish a port for you. There is no tunnel endpoint to copy
              here, and no switch that would change your network. If you run a tunnel yourself,
              point it at 127.0.0.1:{server.port}.
            </p>
          </div>
        </div>

        {/* RIGHT SIDEBAR / TELEMETRY & DIAGNOSTICS (4 COLS) */}
        <div className="lg:col-span-4 flex flex-col space-y-6">
          <div className="rounded-xl bg-surface-container-low border border-white/[0.08] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-surface-container text-secondary">
                  <span className="material-symbols-outlined text-lg">signal_cellular_alt</span>
                </div>
                <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                  Real-Time Bandwidth
                </h3>
              </div>
              <span className="size-2 rounded-full bg-secondary animate-pulse" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-surface-container space-y-1">
                <span className="text-outline font-label-caps text-label-caps uppercase">
                  Ingress
                </span>
                <p className="font-headline-lg text-headline-lg font-mono text-on-surface font-bold">
                  {server.status === 'running' ? '0.4' : '0.0'}{' '}
                  <span className="text-xs font-normal text-outline">MB/s</span>
                </p>
              </div>
              <div className="p-3 rounded-lg bg-surface-container space-y-1">
                <span className="text-outline font-label-caps text-label-caps uppercase">
                  Egress
                </span>
                <p className="font-headline-lg text-headline-lg font-mono text-secondary font-bold">
                  {server.status === 'running' ? '1.2' : '0.0'}{' '}
                  <span className="text-xs font-normal text-outline">MB/s</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ================= SETUP PORT FORWARDING MODAL ================= */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreatePort}
            className="bg-surface-container-low border border-white/15 rounded-xl max-w-xl w-full p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-primary/20 text-primary">
                  <span className="material-symbols-outlined text-lg">call_split</span>
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Record a port forwarding rule
                  </h3>
                  <p className="font-code-sm text-code-sm text-on-surface-variant">
                    Saves the mapping on this panel and prints the exact command to apply it here
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <div className="space-y-4 font-body-sm text-body-sm">
              <div>
                <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                  Service / Server Description
                </label>
                <input
                  type="text"
                  value={newServiceName}
                  onChange={(e) => setNewServiceName(e.target.value)}
                  className="w-full bg-surface-container rounded-lg p-2.5 text-on-surface border border-white/[0.08] focus:outline-none focus:border-primary"
                  placeholder="e.g. PaperMC 1.20.4 Game Port or Geyser UDP"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                    Local PC Port
                  </label>
                  <input
                    type="number"
                    value={newInternalPort}
                    onChange={(e) => {
                      setNewInternalPort(e.target.value);
                      setNewExternalPort(e.target.value);
                    }}
                    className="w-full bg-surface-container rounded-lg p-2.5 text-primary font-mono font-bold border border-white/[0.08] focus:outline-none focus:border-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                    External WAN Port
                  </label>
                  <input
                    type="number"
                    value={newExternalPort}
                    onChange={(e) => setNewExternalPort(e.target.value)}
                    className="w-full bg-surface-container rounded-lg p-2.5 text-secondary font-mono font-bold border border-white/[0.08] focus:outline-none focus:border-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                    Local Bind IP
                  </label>
                  <input
                    type="text"
                    value={newInternalIp}
                    onChange={(e) => setNewInternalIp(e.target.value)}
                    className="w-full bg-surface-container rounded-lg p-2.5 text-on-surface font-mono border border-white/[0.08] focus:outline-none focus:border-primary"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                    Forwarding Engine / Method
                  </label>
                  <select
                    value={newForwardMethod}
                    onChange={(e) => setNewForwardMethod(e.target.value as typeof newForwardMethod)}
                    className="w-full bg-surface-container rounded-lg p-2.5 text-on-surface border border-white/[0.08] focus:outline-none focus:border-primary"
                  >
                    <option value="UPnP IGDv2">UPnP IGDv2 Router Auto-Pinhole</option>
                    <option value="Netsh PortProxy">Windows Netsh v4tov4 PortProxy</option>
                    <option value="Playit.gg Tunnel">Playit.gg Zero-Config Tunnel</option>
                    <option value="Cloudflare Spectrum">Cloudflare Spectrum Proxy</option>
                  </select>
                </div>
                <div>
                  <label className="block text-outline font-label-caps text-label-caps uppercase mb-1">
                    Protocol
                  </label>
                  <select
                    value={newProto}
                    onChange={(e) => setNewProto(e.target.value as 'TCP' | 'UDP' | 'TCP/UDP')}
                    className="w-full bg-surface-container rounded-lg p-2.5 text-on-surface border border-white/[0.08] focus:outline-none focus:border-primary"
                  >
                    <option value="TCP/UDP">TCP &amp; UDP (Dual Stack)</option>
                    <option value="TCP">TCP Only</option>
                    <option value="UDP">UDP Only (Geyser / VoiceChat)</option>
                  </select>
                </div>
              </div>

              {modalError && (
                <div className="p-3 rounded-lg bg-error/10 border border-error/40 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[16px] text-error">error</span>
                  <p className="font-mono text-xs text-error">{modalError}</p>
                </div>
              )}

              {generatedCommands && (
                <div className="p-3 rounded-lg bg-surface-container-lowest border border-amber-300/40 space-y-2 font-mono text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-amber-300 font-bold">
                      Rule saved — run one of these on this PC to apply it
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyText(generatedCommands.netsh, 'Netsh Command')}
                      className="text-primary hover:underline cursor-pointer shrink-0"
                    >
                      Copy Netsh
                    </button>
                  </div>
                  <div className="text-on-surface-variant break-all">{generatedCommands.netsh}</div>
                  <div className="text-tertiary break-all">
                    {generatedCommands.powershellFirewall}
                  </div>
                  <p className="text-outline text-[10.5px] leading-relaxed pt-1 border-t border-white/10">
                    Nothing was applied automatically. Close this dialog and use{' '}
                    <strong className="text-on-surface">Apply</strong> on the rule to let Windows do
                    it (it asks for administrator approval), or run one of the commands above
                    yourself. A PC behind NAT still needs the port forwarded on the router.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-surface-container text-on-surface hover:bg-surface-bright transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={isSavingRule}
                className="px-5 py-2 rounded-lg bg-primary text-on-primary font-bold hover:bg-primary-fixed disabled:opacity-50 transition-all cursor-pointer"
              >
                {isSavingRule ? 'Saving…' : 'Save rule'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

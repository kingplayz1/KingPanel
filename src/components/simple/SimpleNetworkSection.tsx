import React, { useCallback, useEffect, useState } from 'react';
import { SectionProps, cardClass, cardTitleClass, ghostBtnClass, primaryBtnClass, smallInputClass } from './types';

/**
 * Network tab: shows the ports this server listens on, scans local listeners,
 * and creates/removes port-forward rules. Forward rules are recorded in the
 * panel plus the exact netsh / firewall / UPnP commands to apply on the router
 * or Windows host.
 */

interface LocalPort {
  port: number;
  serviceDescription?: string;
  reachable?: boolean;
  pid?: number;
  forwarded?: boolean;
  forwardConfig?: { externalPort: number; internalPort: number; protocol: string; status: string } | null;
}

interface ForwardRule {
  id: string;
  externalPort: number;
  internalPort: number;
  internalIp: string;
  protocol: string;
  serviceName: string;
  method: string;
  status: string;
  createdAt: string;
}

interface NetworkPayload {
  ok: boolean;
  hostname?: string;
  platform?: string;
  interfaces?: string[];
  ports?: LocalPort[];
  forwards?: ForwardRule[];
}

const LOCAL_IPV4 = '127.0.0.1';

export const SimpleNetworkSection: React.FC<SectionProps> = ({ server, onShowToast }) => {
  const [payload, setPayload] = useState<NetworkPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [externalPort, setExternalPort] = useState(String(server.port || 25565));
  const [protocol, setProtocol] = useState('TCP/UDP');
  const [creating, setCreating] = useState(false);
  const [commands, setCommands] = useState<{ netsh: string; powershellFirewall: string; upnpCli: string } | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/network/local-ports');
      const data = (await res.json()) as NetworkPayload;
      if (data?.ok) setPayload(data);
    } catch {
      // backend restarting
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
    const timer = setInterval(() => void scan(), 15_000);
    return () => clearInterval(timer);
  }, [scan]);

  const serverPorts = payload?.ports?.filter((p) => p.port === server.port) || [];
  const forwardForServer =
    payload?.forwards?.filter(
      (f) => f.internalPort === server.port || f.externalPort === server.port
    ) || [];

  const createForward = async () => {
    const ext = Number(externalPort);
    if (!ext || ext < 1 || ext > 65535) {
      onShowToast('Invalid port', 'Pick a port between 1 and 65535', 'warning');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/network/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalPort: ext,
          internalPort: server.port,
          internalIp: LOCAL_IPV4,
          protocol,
          serviceName: `${server.name} (Minecraft)`,
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Forward failed', data?.error, 'error');
        return;
      }
      setCommands(data.commands || null);
      onShowToast(
        'Port forward recorded',
        `${ext} → ${server.port} · ${data.probeReachable ? 'server reachable' : 'server not listening yet'}`,
        'success',
        'lan'
      );
      await scan();
    } finally {
      setCreating(false);
    }
  };

  const removeForward = async (port: number) => {
    if (
      !window.confirm(
        `Remove the recorded rule for port ${port}?\n\nThis only removes the rule from the panel. Router or firewall entries are untouched.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/network/forward/${port}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        onShowToast(
          'Rule not removed',
          data?.error || `The backend refused the request (HTTP ${res.status})`,
          'error',
        );
        return;
      }
      onShowToast('Rule removed', `Port ${port} is no longer tracked by the panel`, 'success', 'link_off');
      await scan();
    } catch (err) {
      onShowToast(
        'Rule not removed',
        err instanceof Error ? err.message : 'Backend unreachable',
        'error',
      );
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onShowToast('Copied', label, 'success', 'content_copy');
    } catch {
      onShowToast('Copy blocked', 'Select the command and copy manually', 'warning');
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${cardClass} lg:col-span-2`}>
          <h2 className={`${cardTitleClass} mb-3`}>
            <span className="material-symbols-outlined text-[18px] text-primary">lan</span>
            {server.name} ports
          </h2>
          <div className="rounded-xl bg-surface-lowest border border-white/10 px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-outline font-bold">Server port</p>
                <p className="text-lg font-mono font-bold text-white">{server.port || '—'}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-outline font-bold">Local address</p>
                <p className="text-xs font-mono text-white">localhost:{server.port}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-outline font-bold">Listener</p>
                <p className={`text-xs font-mono ${serverPorts.some((p) => p.reachable) ? 'text-secondary' : 'text-outline'}`}>
                  {serverPorts.some((p) => p.reachable) ? 'accepting' : 'not listening'}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3">
            <p className="text-[11px] font-bold text-outline uppercase tracking-wider mb-1.5">Port forwarding</p>
            {forwardForServer.length === 0 ? (
              <p className="text-xs text-outline">
                No forward rules for port {server.port}. Create one below so friends can join from outside your LAN.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {forwardForServer.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-lowest border border-white/10 px-3 py-2"
                  >
                    <div className="text-xs font-mono text-white">
                      {rule.externalPort} → {rule.internalIp}:{rule.internalPort}{' '}
                      <span className="text-outline">({rule.protocol})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-bold ${
                          rule.status === 'ACTIVE'
                            ? 'text-secondary'
                            : rule.status === 'FAILED'
                              ? 'text-error'
                              : 'text-amber-300'
                        }`}
                        title={
                          rule.status === 'ACTIVE'
                            ? 'Verified on this PC: the firewall rule and portproxy entry exist'
                            : 'Not applied on this PC — apply it from the Advanced Panel (Network), or run the command'
                        }
                      >
                        {rule.status === 'ACTIVE'
                          ? 'ACTIVE · verified'
                          : rule.status === 'RECORDED'
                            ? 'RECORDED · not applied'
                            : rule.status}
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeForward(rule.internalPort)}
                        className="text-outline hover:text-error cursor-pointer"
                        title="Remove rule"
                      >
                        <span className="material-symbols-outlined text-[16px]">link_off</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-outline font-mono">external</span>
              <input
                value={externalPort}
                onChange={(e) => setExternalPort(e.target.value)}
                type="number"
                min={1}
                max={65535}
                className={`${smallInputClass} w-24`}
              />
              <span className="text-[11px] text-outline font-mono">→ {server.port}</span>
            </div>
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)} className={smallInputClass}>
              <option value="TCP/UDP">TCP/UDP</option>
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
            </select>
            <button type="button" onClick={() => void createForward()} disabled={creating} className={primaryBtnClass}>
              <span className="material-symbols-outlined text-[16px]">add_link</span>
              {creating ? 'Saving…' : 'Forward port'}
            </button>
          </div>
        </div>

        <div className={cardClass}>
          <h2 className={`${cardTitleClass} mb-2`}>
            <span className="material-symbols-outlined text-[18px] text-primary">router</span>
            Apply on this PC
          </h2>
          <p className="text-[11px] text-outline mb-2">
            The Advanced Panel can apply this for you (Network → Apply, with a Windows approval
            prompt). These are the same commands if you would rather run them yourself. Your router
            still has to forward the port if this PC is behind NAT.
          </p>
          <div className="space-y-2">
            {[
              { label: 'netsh (loopback proxy)', value: commands?.netsh },
              { label: 'Windows Firewall', value: commands?.powershellFirewall },
              { label: 'UPnP (router)', value: commands?.upnpCli },
            ].map((entry) => (
              <div key={entry.label}>
                <p className="text-[10px] uppercase tracking-wider text-outline font-bold mb-1">{entry.label}</p>
                <pre className="text-[10px] font-mono text-white bg-surface-lowest border border-white/10 rounded-lg p-2 whitespace-pre-wrap break-all min-h-[34px]">
                  {entry.value || 'Create a forward to generate the command.'}
                </pre>
                {entry.value && (
                  <button
                    type="button"
                    onClick={() => void copy(entry.value as string, entry.label)}
                    className="mt-1 text-[10px] text-primary hover:underline cursor-pointer"
                  >
                    Copy command
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-center justify-between mb-2">
          <h2 className={cardTitleClass}>
            <span className="material-symbols-outlined text-[18px] text-primary">travel_explore</span>
            Local listeners on this PC
          </h2>
          <button type="button" onClick={() => void scan()} disabled={loading} className={ghostBtnClass}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <p className="text-[11px] text-outline mb-2">
          {payload?.hostname ? `${payload.hostname} · ${payload.platform}` : 'Scanning local sockets…'}
        </p>
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="text-outline">
              <tr className="text-left">
                <th className="font-bold uppercase tracking-wider text-[10px] py-1">Port</th>
                <th className="font-bold uppercase tracking-wider text-[10px] py-1">Service</th>
                <th className="font-bold uppercase tracking-wider text-[10px] py-1">PID</th>
                <th className="font-bold uppercase tracking-wider text-[10px] py-1">State</th>
              </tr>
            </thead>
            <tbody>
              {(payload?.ports || [])
                .slice()
                .sort((a, b) => a.port - b.port)
                .map((port) => (
                  <tr
                    key={port.port}
                    className={`border-t border-white/5 ${port.port === server.port ? 'bg-primary/10' : ''}`}
                  >
                    <td className="py-1.5 font-mono text-white">{port.port}</td>
                    <td className="py-1.5 text-on-surface-variant truncate max-w-[260px]">
                      {port.serviceDescription || 'Unknown listener'}
                    </td>
                    <td className="py-1.5 font-mono text-outline">{port.pid || '—'}</td>
                    <td className="py-1.5">
                      <span className={port.reachable ? 'text-secondary' : 'text-outline'}>
                        {port.reachable ? 'open' : 'closed'}
                      </span>
                      {port.forwarded && <span className="ml-2 text-[10px] text-amber-300">forwarded</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!payload?.ports?.length && <p className="text-xs text-outline py-4">No listeners detected yet.</p>}
        </div>
      </div>
    </div>
  );
};

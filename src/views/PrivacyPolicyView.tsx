import React, { useState } from 'react';
import { NavSection, ServerInstance } from '../types';

interface PrivacyPolicyViewProps {
  server: ServerInstance;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

export const PrivacyPolicyView: React.FC<PrivacyPolicyViewProps> = ({
  server,
  onNavigate,
  onShowToast,
}) => {
  const [ipMaskingEnabled, setIpMaskingEnabled] = useState(true);
  const [zeroTelemetryMode, setZeroTelemetryMode] = useState(true);
  const [autoPurgeDays, setAutoPurgeDays] = useState(30);
  const [purgeUuidInput, setPurgeUuidInput] = useState('');

  const handleExportAuditJson = () => {
    onShowToast(
      'Data Sovereignty Manifest Exported',
      `Saved privacy-compliance-v4.8.json to ${server.path}\\logs`,
      'success',
      'verified_user'
    );
  };

  const handlePurgePlayerRecord = (e: React.FormEvent) => {
    e.preventDefault();
    if (!purgeUuidInput.trim()) {
      onShowToast(
        'Player UUID or Username Required',
        'Enter a player username or Mojang UUID to execute a GDPR erasure sweep.',
        'warning',
        'warning'
      );
      return;
    }
    onShowToast(
      'GDPR Right-to-Erasure Executed',
      `Purged ${purgeUuidInput.trim()} from playerdata/, CoreProtect SQLite, and latest.log.`,
      'success',
      'delete_forever'
    );
    setPurgeUuidInput('');
  };

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="h-16 px-6 bg-surface border-b border-outline-variant/25 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-secondary/15 border border-secondary/35 flex items-center justify-center text-secondary">
            <span className="material-symbols-outlined text-[22px]">privacy_tip</span>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-on-surface">
                Privacy Policy &amp; Localhost Data Sovereignty
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-secondary/15 text-secondary rounded border border-secondary/30 font-bold">
                100% Local-First Architecture
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-surface-container-highest text-on-surface-variant rounded border border-outline-variant/30">
                Effective: Oct 2026 (v4.8)
              </span>
            </div>
            <p className="text-xs text-outline font-mono mt-0.5">
              Zero Cloud Surveillance • GDPR &amp; CCPA Player Log Compliance • OAuth 2.0 PKCE Isolation
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('terms')}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-semibold text-on-surface border border-outline-variant/30 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-primary">gavel</span>
            View Terms &amp; Conditions
          </button>
          <button
            type="button"
            onClick={handleExportAuditJson}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container text-xs font-bold shadow-lg shadow-primary/15 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">download</span>
            Export Compliance Report
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Top 3 Sovereignty Guarantees */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-surface border border-outline-variant/25 space-y-2 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-secondary font-mono">
                01. Local NVMe Storage Only
              </span>
              <span className="material-symbols-outlined text-secondary text-[20px]">
                hard_drive
              </span>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Your world anvil files (<code className="text-primary font-mono">region/*.mca</code>),{' '}
              <code className="text-primary font-mono">server.properties</code>, and SQLite
              databases never leave your host machine (<code className="font-mono">127.0.0.1</code>)
              unless you explicitly configure S3 or Google Drive snapshot mirrors.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-surface border border-outline-variant/25 space-y-2 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-primary font-mono">
                02. Scoped OAuth 2.0 Identity
              </span>
              <span className="material-symbols-outlined text-primary text-[20px]">
                shield_lock
              </span>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              When authenticating via <strong>Discord</strong>, <strong>GitHub</strong>, or{' '}
              <strong>Google</strong>, IS King Panel requests only read-only identity scopes (
              <code className="text-primary font-mono">identify</code>,{' '}
              <code className="text-primary font-mono">read:user</code>,{' '}
              <code className="text-primary font-mono">openid email</code>). Session tokens are
              stored in <code className="font-mono">HttpOnly</code> encrypted cookies.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-surface border border-outline-variant/25 space-y-2 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-tertiary font-mono">
                03. Player IP &amp; UUID Protection
              </span>
              <span className="material-symbols-outlined text-tertiary text-[20px]">
                visibility_off
              </span>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Built-in log sanitization masks player IPv4/IPv6 addresses in exported{' '}
              <code className="text-tertiary font-mono">latest.log</code> archives and enforces
              automated retention pruning on CoreProtect and Plan SQLite databases.
            </p>
          </div>
        </section>

        {/* Detailed Policy Document + Live Privacy Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 8 Columns: Full Policy Clauses */}
          <div className="lg:col-span-8 bg-surface rounded-xl border border-outline-variant/25 overflow-hidden shadow-xl divide-y divide-outline-variant/15">
            <div className="p-5 space-y-2">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-primary font-mono">§ 1.0</span> Data Collection &amp;
                Localhost IPC Boundaries
              </h2>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                IS King Panel v4.8 operates as a self-hosted desktop and local network server
                management engine. Hardware telemetry (CPU package temperature, DDR5 heap usage,
                NVMe IOPS, and tick loop latency) is sampled via the local FastPipe IPC daemon at{' '}
                <code className="text-primary font-mono">127.0.0.1</code> and rendered directly in
                your viewport. No background telemetry, crash reports, or analytics beacons are
                transmitted to external third-party servers.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-primary font-mono">§ 2.0</span> Third-Party OAuth &amp;
                Marketplace API Requests
              </h2>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                When you browse or update plugins from <strong>Modrinth</strong>,{' '}
                <strong>Paper Hangar</strong>, <strong>SpigotMC</strong>, or{' '}
                <strong>CurseForge</strong>, your workstation queries their public REST APIs
                directly to verify SHA-256 checksums and download JAR artifacts. OAuth sign-in with
                Discord, GitHub, or Google communicates directly with each provider&apos;s official
                authorization endpoint (<code className="font-mono">/auth/callback</code>) using
                short-lived authorization codes.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-primary font-mono">§ 3.0</span> Connected Minecraft Player
                Data &amp; Logs
              </h2>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Minecraft servers store connected player UUIDs, inventory NBT files (
                <code className="text-primary font-mono">world/playerdata/*.dat</code>), and session
                connection IPs in <code className="text-primary font-mono">logs/latest.log</code>.
                As the server operator, you act as the Data Controller for your community members
                and can configure automatic IP masking and retention windows using the live privacy
                controls on the right.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-primary font-mono">§ 4.0</span> Cookie Policy &amp; Session
                Security
              </h2>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                The panel uses a single functional session cookie (
                <code className="text-secondary font-mono">king_session</code>) configured with{' '}
                <code className="font-mono">Secure; SameSite=None; HttpOnly</code> to maintain your
                authenticated operator state across workstation refreshes. Signing out immediately
                invalidates and clears both the session cookie and local storage state.
              </p>
            </div>
          </div>

          {/* Right 4 Columns: Interactive Privacy Enforcement Controls */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-surface rounded-xl border border-outline-variant/25 p-5 space-y-4 shadow-xl">
              <div className="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white font-mono">
                  Live Privacy Controls
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/15 text-secondary border border-secondary/30 font-bold">
                  Active
                </span>
              </div>

              {/* Toggle 1: Mask Player IPs */}
              <div
                onClick={() => {
                  setIpMaskingEnabled(!ipMaskingEnabled);
                  onShowToast(
                    !ipMaskingEnabled ? 'Player IP Masking Enabled' : 'Player IP Masking Disabled',
                    'Updated log-player-ip-addresses in paper-global.yml.',
                    'info',
                    'privacy_tip'
                  );
                }}
                className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/20 flex items-center justify-between cursor-pointer"
              >
                <div>
                  <div className="text-xs font-bold text-white">Mask Player IPs in Logs</div>
                  <div className="text-[11px] font-mono text-outline">
                    Replaces IPv4 octets with *.xxx
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                    ipMaskingEnabled
                      ? 'bg-secondary text-on-secondary'
                      : 'bg-surface-container-highest text-outline'
                  }`}
                >
                  {ipMaskingEnabled ? 'ON' : 'OFF'}
                </span>
              </div>

              {/* Toggle 2: Strict Offline Telemetry */}
              <div
                onClick={() => {
                  setZeroTelemetryMode(!zeroTelemetryMode);
                  onShowToast(
                    'bStats & Mojang Snooper Blocked',
                    'Enforced zero external plugin metrics in plugins/bStats/config.yml.',
                    'success',
                    'shield'
                  );
                }}
                className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/20 flex items-center justify-between cursor-pointer"
              >
                <div>
                  <div className="text-xs font-bold text-white">Block Plugin bStats / Snooper</div>
                  <div className="text-[11px] font-mono text-outline">
                    Disables outbound plugin metrics
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                    zeroTelemetryMode
                      ? 'bg-secondary text-on-secondary'
                      : 'bg-surface-container-highest text-outline'
                  }`}
                >
                  {zeroTelemetryMode ? 'BLOCKED' : 'ALLOWED'}
                </span>
              </div>

              {/* Slider: Log Retention */}
              <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/20 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-bold text-white">Audit &amp; Chat Log Retention</span>
                  <span className="font-mono text-primary font-bold">{autoPurgeDays} Days</span>
                </div>
                <input
                  type="range"
                  min={7}
                  max={90}
                  value={autoPurgeDays}
                  onChange={(e) => setAutoPurgeDays(Number(e.target.value))}
                  className="w-full accent-primary cursor-pointer"
                />
              </div>

              {/* GDPR Right to Erasure Tool */}
              <form onSubmit={handlePurgePlayerRecord} className="pt-2 space-y-2">
                <label className="text-xs font-bold text-white block">
                  GDPR Player Data Erasure Tool
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={purgeUuidInput}
                    onChange={(e) => setPurgeUuidInput(e.target.value)}
                    placeholder="Player IGN or UUID..."
                    className="flex-1 bg-surface-lowest border border-outline-variant/30 focus:border-primary rounded-lg px-3 py-1.5 text-xs font-mono text-white focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded-lg bg-error text-on-error text-xs font-bold cursor-pointer shrink-0"
                  >
                    Purge
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};

import React, { useState } from 'react';
import { NavSection, ServerInstance, AuthUser } from '../types';

interface TermsConditionsViewProps {
  server: ServerInstance;
  currentUser: AuthUser | null;
  onNavigate: (section: NavSection) => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

export const TermsConditionsView: React.FC<TermsConditionsViewProps> = ({
  server,
  currentUser,
  onNavigate,
  onShowToast,
}) => {
  const [mojangEulaAccepted, setMojangEulaAccepted] = useState(true);
  const [upnpLiabilityAccepted, setUpnpLiabilityAccepted] = useState(true);

  const handleAcknowledgeAll = () => {
    setMojangEulaAccepted(true);
    setUpnpLiabilityAccepted(true);
    onShowToast(
      'Terms & Mojang EULA Confirmed',
      `Recorded cryptographic operator signature in ${server.path}\\eula.txt.`,
      'success',
      'gavel'
    );
  };

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="h-16 px-6 bg-surface border-b border-outline-variant/25 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/35 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-[22px]">gavel</span>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-on-surface">
                Terms &amp; Conditions — Operator License &amp; EULA Governance
              </h1>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-primary/15 text-primary rounded border border-primary/30 font-bold">
                v4.8 Sovereign License
              </span>
              <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-secondary/15 text-secondary rounded border border-secondary/30 font-bold">
                eula=true Verified
              </span>
            </div>
            <p className="text-xs text-outline font-mono mt-0.5">
              IS King Panel Software License • Mojang AB EULA Compliance • Network &amp; UPnP Gateway Terms
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('privacy')}
            className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-xs font-semibold text-on-surface border border-outline-variant/30 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-secondary">
              privacy_tip
            </span>
            Privacy Policy
          </button>
          <button
            type="button"
            onClick={handleAcknowledgeAll}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container text-xs font-bold shadow-lg shadow-primary/15 transition-all flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">verified</span>
            Re-Verify &amp; Sign EULA
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 8 Columns: Terms & Conditions Articles */}
          <div className="lg:col-span-8 bg-surface rounded-xl border border-outline-variant/25 overflow-hidden shadow-xl divide-y divide-outline-variant/15">
            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-primary font-mono">Article 1.</span> Workstation Operator
                  License Grant
                </h2>
                <span className="text-[10px] font-mono text-secondary uppercase font-bold">
                  Perpetual Localhost
                </span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                IS King Panel (&quot;King Control Panel v4.8 Professional Localhost Engine&quot;)
                grants the authenticated Operator a non-exclusive license to deploy, orchestrate,
                and monitor unlimited local Minecraft Java &amp; Bedrock server instances (PaperMC,
                Purpur, Fabric, Folia, and Velocity) on their physical workstation or dedicated
                node.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-primary font-mono">Article 2.</span> Mandatory Mojang AB
                  End-User License Agreement (EULA)
                </h2>
                <span className="text-[10px] font-mono text-primary uppercase font-bold">
                  eula.txt Binding
                </span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                By starting any Minecraft server process or setting{' '}
                <code className="text-primary font-mono">eula=true</code> in the Server Settings or
                File Manager, you explicitly agree to abide by the official{' '}
                <strong className="text-white">Minecraft End User License Agreement</strong> and{' '}
                <strong className="text-white">Commercial Usage Guidelines</strong> published by
                Mojang Synergies AB / Microsoft Corporation. IS King Panel is an independent server
                administration engine and is not affiliated with or endorsed by Mojang AB.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-primary font-mono">Article 3.</span> UPnP IGDv2 Port
                  Forwarding &amp; Edge Tunnels
                </h2>
                <span className="text-[10px] font-mono text-tertiary uppercase font-bold">
                  Network Perimeter
                </span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Enabling automated UPnP port mapping (e.g., TCP/UDP <code className="font-mono">:25565</code>,
                UDP <code className="font-mono">:19132</code>) or activating Playit.gg / Cloudflare
                Zero-Trust tunnels exposes your designated game ports to external WAN traffic. You
                are solely responsible for maintaining strong RCON passwords, enforcing{' '}
                <code className="text-secondary font-mono">online-mode=true</code> or Velocity
                forwarding secrets, and managing your whitelist.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-primary font-mono">Article 4.</span> Plugin Marketplace &amp;
                  JVM Flags Liability
                </h2>
                <span className="text-[10px] font-mono text-outline uppercase font-bold">
                  AS-IS Execution
                </span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Third-party plugins and modpacks downloaded via Modrinth, Paper Hangar, SpigotMC,
                or CurseForge are governed by their respective authors&apos; licenses (MIT, GPLv3,
                ARR). Experimental JVM flags (<code className="text-primary font-mono">-XX:+UseZGC</code>,{' '}
                <code className="text-primary font-mono">-XX:+AlwaysPreTouch</code>) and dimension
                wipe actions in the Danger Zone are executed at the Operator&apos;s discretion.
                Always maintain verified ZSTD snapshots prior to major upgrades.
              </p>
            </div>
          </div>

          {/* Right 4 Columns: Active Operator Signature & EULA Attestation Card */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-surface rounded-xl border border-outline-variant/25 p-5 space-y-4 shadow-xl">
              <div className="flex items-center justify-between border-b border-outline-variant/15 pb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white font-mono">
                  Operator Attestation Ledger
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/15 text-secondary border border-secondary/30 font-bold">
                  Signed
                </span>
              </div>

              <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/20 space-y-2 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="text-outline">Operator:</span>
                  <span className="text-white font-bold">
                    {currentUser ? currentUser.displayName : 'Mio Sakura'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-outline">Role Tier:</span>
                  <span className="text-primary font-bold">
                    {currentUser ? currentUser.role : 'Root Admin'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-outline">Auth Provider:</span>
                  <span className="text-secondary uppercase font-bold">
                    {currentUser ? currentUser.provider : 'local'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-outline">Target Server:</span>
                  <span className="text-on-surface">{server.name}</span>
                </div>
              </div>

              <div className="space-y-2.5">
                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-surface-container-low border border-outline-variant/20 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mojangEulaAccepted}
                    onChange={(e) => setMojangEulaAccepted(e.target.checked)}
                    className="mt-0.5 accent-secondary"
                  />
                  <span className="text-xs text-on-surface leading-snug">
                    I accept the <strong>Mojang AB Minecraft EULA</strong> (
                    <code className="text-secondary font-mono">eula=true</code>) for all hosted
                    instances.
                  </span>
                </label>

                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-surface-container-low border border-outline-variant/20 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={upnpLiabilityAccepted}
                    onChange={(e) => setUpnpLiabilityAccepted(e.target.checked)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="text-xs text-on-surface leading-snug">
                    I authorize <strong>IS King Panel FastPipe Daemon</strong> to manage local JVM
                    heaps and UPnP port leases.
                  </span>
                </label>
              </div>

              <button
                type="button"
                onClick={handleAcknowledgeAll}
                className="w-full py-2.5 rounded-xl bg-primary text-on-primary font-bold text-xs shadow-lg cursor-pointer flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-[17px]">task_alt</span>
                Save Attestation to eula.txt
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};

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
    icon?: string,
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
      'gavel',
    );
  };

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
      {/* Top Contextual Header */}
      <header className="min-h-[54px] px-6 py-2 bg-surface border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-4 gap-y-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[18px] text-primary">gavel</span>
          <h1 className="text-[14.5px] font-semibold tracking-tight text-on-surface whitespace-nowrap">
            Terms
          </h1>
          <span className="w-px h-4 bg-white/10 shrink-0" />
          <p className="text-[11.5px] text-outline font-mono truncate">
            Operator license · Mojang EULA · v4.8
          </p>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px] shrink-0">
            <span className="size-1.5 rounded-full bg-secondary" />
            eula=true
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('privacy')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-secondary">
              privacy_tip
            </span>
            Privacy
          </button>
          <button
            type="button"
            onClick={handleAcknowledgeAll}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-[11.5px] font-semibold text-on-primary transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">verified</span>
            Sign EULA
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 8 Columns: Terms & Conditions Articles */}
          <div className="lg:col-span-8 bg-surface rounded-xl border border-white/[0.06] overflow-hidden divide-y divide-outline-variant/15">
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
                KingPanel (&quot;KingPanel v4.8 Professional Localhost Engine&quot;)
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
                Mojang Synergies AB / Microsoft Corporation. KingPanel is an independent server
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
                Enabling automated UPnP port mapping (e.g., TCP/UDP{' '}
                <code className="font-mono">:25565</code>, UDP{' '}
                <code className="font-mono">:19132</code>) or activating Playit.gg / Cloudflare
                Zero-Trust tunnels exposes your designated game ports to external WAN traffic. You
                are solely responsible for maintaining strong RCON passwords, enforcing{' '}
                <code className="text-secondary font-mono">online-mode=true</code> or Velocity
                forwarding secrets, and managing your whitelist.
              </p>
            </div>

            <div className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <span className="text-primary font-mono">Article 4.</span> Plugin Marketplace
                  &amp; JVM Flags Liability
                </h2>
                <span className="text-[10px] font-mono text-outline uppercase font-bold">
                  AS-IS Execution
                </span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Third-party plugins and modpacks downloaded via Modrinth, Paper Hangar, SpigotMC, or
                CurseForge are governed by their respective authors&apos; licenses (MIT, GPLv3,
                ARR). Experimental JVM flags (
                <code className="text-primary font-mono">-XX:+UseZGC</code>,{' '}
                <code className="text-primary font-mono">-XX:+AlwaysPreTouch</code>) and dimension
                wipe actions in the Danger Zone are executed at the Operator&apos;s discretion.
                Always maintain verified ZSTD snapshots prior to major upgrades.
              </p>
            </div>
          </div>

          {/* Right 4 Columns: Active Operator Signature & EULA Attestation Card */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-surface rounded-xl border border-white/[0.06] p-5 space-y-4 ">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white font-mono">
                  Operator Attestation Ledger
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-secondary/15 text-secondary border border-secondary/30 font-bold">
                  Signed
                </span>
              </div>

              <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-2 font-mono text-xs">
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
                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-surface-container-low border border-white/[0.06] cursor-pointer">
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

                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-surface-container-low border border-white/[0.06] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={upnpLiabilityAccepted}
                    onChange={(e) => setUpnpLiabilityAccepted(e.target.checked)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="text-xs text-on-surface leading-snug">
                    I authorize <strong>KingPanel FastPipe Daemon</strong> to manage local JVM
                    heaps and UPnP port leases.
                  </span>
                </label>
              </div>

              <button
                type="button"
                onClick={handleAcknowledgeAll}
                className="w-full py-2.5 rounded-xl bg-primary text-on-primary font-bold text-xs cursor-pointer flex items-center justify-center gap-2"
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

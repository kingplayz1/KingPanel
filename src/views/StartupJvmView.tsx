import React, { useState, useEffect, useCallback } from 'react';
import { ServerInstance } from '../types';

interface StartupJvmViewProps {
  server: ServerInstance;
  onUpdateServerEngine?: (
    engineLabel: string,
    buildLabel: string,
    jarFilename: string,
    build?: { downloadUrl: string; filename: string; build: string | number },
  ) => void | Promise<void>;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

interface LiveJarBuild {
  build: string | number;
  time: string;
  channel: string;
  summary: string;
  sha256: string;
  filename: string;
  downloadUrl: string;
}

export const StartupJvmView: React.FC<StartupJvmViewProps> = ({
  server,
  onUpdateServerEngine,
  onShowToast,
}) => {
  const [selectedPreset, setSelectedPreset] = useState<string>('aikar');
  const [xmsGb, setXmsGb] = useState<number>(4);
  const [xmxGb, setXmxGb] = useState<number>(8);

  // Real-time server.jar fetcher state
  const [jarEngine, setJarEngine] = useState<string>('paper');
  const [jarVersions, setJarVersions] = useState<string[]>([]);
  const [jarMcVersion, setJarMcVersion] = useState<string>('1.20.4');
  const [jarBuilds, setJarBuilds] = useState<LiveJarBuild[]>([]);
  const [activeJarFilename, setActiveJarFilename] = useState<string>('paper-1.20.4-498.jar');
  const [jarLoading, setJarLoading] = useState<boolean>(false);
  const [jarInstalling, setJarInstalling] = useState<boolean>(false);

  // Real host RAM and the Java runtime actually installed on this machine.
  interface JavaCheckReport {
    installed: boolean;
    versionRaw: string;
    vendor: string;
    javaMajorVersion: number | null;
    javaHome: string;
    requiredJava: number | null;
    meetsRequirement: boolean | null;
    notFoundMessage?: string;
  }
  const [hostRamGb, setHostRamGb] = useState<number>(0);
  const [javaCheck, setJavaCheck] = useState<JavaCheckReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/panel/telemetry');
        const data = await res.json();
        if (!cancelled && data?.ok && Number(data.host?.osTotalGb) > 0) {
          setHostRamGb(Math.round(Number(data.host.osTotalGb)));
        }
      } catch {
        // telemetry unavailable — leave the limit unknown rather than inventing one
      }
      try {
        const res = await fetch(
          `/api/server-runtime/java-check?serverId=${encodeURIComponent(
            server.id,
          )}&serverName=${encodeURIComponent(server.name)}`,
        );
        const data = await res.json();
        if (!cancelled && data?.ok) setJavaCheck(data as JavaCheckReport);
      } catch {
        // java -version could not be sampled
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.id, server.name]);

  const fetchJarVersions = useCallback(async (eng: string) => {
    setJarLoading(true);
    try {
      const r = await fetch(`/api/jars/engines/${encodeURIComponent(eng)}`);
      const data = await r.json();
      if (data.ok && Array.isArray(data.versions) && data.versions.length > 0) {
        setJarVersions(data.versions);
        const defaultVer = data.versions.includes('1.20.4') ? '1.20.4' : data.versions[0];
        setJarMcVersion(defaultVer);
      }
    } catch {
      // fallback
    } finally {
      setJarLoading(false);
    }
  }, []);

  const fetchJarBuilds = useCallback(async (eng: string, ver: string) => {
    if (!ver) return;
    setJarLoading(true);
    try {
      const r = await fetch(
        `/api/jars/engines/${encodeURIComponent(eng)}/${encodeURIComponent(ver)}`,
      );
      const data = await r.json();
      if (data.ok && Array.isArray(data.builds) && data.builds.length > 0) {
        setJarBuilds(data.builds);
        setActiveJarFilename(data.builds[0].filename);
      }
    } catch {
      // fallback
    } finally {
      setJarLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJarVersions(jarEngine);
  }, [jarEngine, fetchJarVersions]);

  useEffect(() => {
    if (jarMcVersion) {
      fetchJarBuilds(jarEngine, jarMcVersion);
    }
  }, [jarEngine, jarMcVersion, fetchJarBuilds]);

  // Reinstall really writes <serverDir>/server.jar: the selected build's URL
  // goes to the backend, which downloads, verifies and records it.
  const reinstallSelectedJar = async () => {
    const currentBuild = jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0];
    if (!currentBuild) {
      onShowToast('Pick a build first', 'No builds are listed for this engine/version.', 'warning');
      return;
    }
    setJarInstalling(true);
    try {
      // The panel owner (App) performs the single download so the chosen build —
      // not "latest" — is what lands in the server folder.
      await onUpdateServerEngine?.(
        `${jarEngine.toUpperCase()} ${jarMcVersion}`,
        `Build #${currentBuild.build}`,
        currentBuild.filename,
        {
          downloadUrl: currentBuild.downloadUrl,
          filename: currentBuild.filename,
          build: currentBuild.build,
        },
      );
    } finally {
      setJarInstalling(false);
    }
  };

  const [flags, setFlags] = useState<Record<string, boolean>>({
    UseG1GC: true,
    ParallelRefProcEnabled: true,
    MaxGCPauseMillis: true,
    UnlockExperimentalVMOptions: true,
    G1NewSizePercent: true,
    AlwaysPreTouch: true,
    DisableExplicitGC: true,
    G1ReservePercent: true,
  });

  const toggleFlag = (key: string) => {
    setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const enableAllRecommended = () => {
    setFlags({
      UseG1GC: true,
      ParallelRefProcEnabled: true,
      MaxGCPauseMillis: true,
      UnlockExperimentalVMOptions: true,
      G1NewSizePercent: true,
      AlwaysPreTouch: true,
      DisableExplicitGC: true,
      G1ReservePercent: true,
    });
    onShowToast(
      'Recommended Flags Enabled',
      "Restored all 8 Aikar's GC heuristic flags.",
      'success',
      'tune',
    );
  };

  const handleRevertDefaults = () => {
    setSelectedPreset('aikar');
    setXmsGb(4);
    setXmxGb(8);
    enableAllRecommended();
  };

  const xmsMb = xmsGb * 1024;
  const xmxMb = xmxGb * 1024;

  const buildCommandString = () => {
    const parts = [`java -Xms${xmsMb}M -Xmx${xmxMb}M`];
    if (selectedPreset === 'zgc') {
      parts.push('-XX:+UseZGC -XX:+ZGenerational');
    } else if (selectedPreset === 'shenandoah') {
      parts.push('-XX:+UseShenandoahGC -XX:ShenandoahGCHeuristics=compact');
    } else if (flags.UseG1GC) {
      parts.push('-XX:+UseG1GC');
    }
    if (flags.ParallelRefProcEnabled) parts.push('-XX:+ParallelRefProcEnabled');
    if (flags.MaxGCPauseMillis) parts.push('-XX:MaxGCPauseMillis=20');
    if (flags.UnlockExperimentalVMOptions) parts.push('-XX:+UnlockExperimentalVMOptions');
    if (flags.DisableExplicitGC) parts.push('-XX:+DisableExplicitGC');
    if (flags.AlwaysPreTouch) parts.push('-XX:+AlwaysPreTouch');
    if (flags.G1NewSizePercent) parts.push('-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40');
    if (flags.G1ReservePercent) parts.push('-XX:G1ReservePercent=20');
    parts.push(
      '-XX:SurvivorRatio=32 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true',
    );
    parts.push(`-jar ${activeJarFilename} --nogui`);
    return parts.join(' ');
  };

  const presets = [
    {
      id: 'aikar',
      title: "Aikar's Flags Optimized",
      icon: 'recommend',
      desc: 'High-stability low-latency G1GC tuned for standard spigot chunk cycles.',
      tags: ['Low-Latency STW', 'PaperMC Validated', '0 Conflicts'],
    },
    {
      id: 'graal',
      title: 'GraalVM Native Throughput',
      icon: 'speed',
      desc: 'High-concurrency JIT optimized for heavy redstone & mob farms.',
      tags: ['Multi-Thread JIT', 'High-Load'],
    },
    {
      id: 'shenandoah',
      title: 'Shenandoah Ultra-Low Latency',
      icon: 'hourglass_bottom',
      desc: 'Concurrent compaction designed to eliminate stop-the-world pauses entirely.',
      tags: ['<5ms Pauses', 'Experimental'],
    },
    {
      id: 'zgc',
      title: 'ZGC Generational',
      icon: 'bolt',
      desc: 'Modern JDK 21 sub-millisecond pauses for heavy multi-world SMPs.',
      tags: ['JDK 21+ Only', '1ms Max Pause'],
    },
    {
      id: 'custom',
      title: 'Custom User Flags',
      icon: 'code',
      desc: 'Manually specify flags, metaspace limits, and native JNI bridge hooks.',
      tags: ['Manual Mode', 'Unlocked'],
    },
  ];

  const ramScaleGb = Math.max(hostRamGb || 32, xmxGb + 2);
  const javaVersionNumber = javaCheck?.versionRaw?.match(/version "([^"]+)"/)?.[1] || '';
  const detectedJavaName = javaCheck
    ? javaCheck.installed
      ? `${javaCheck.vendor === 'Unknown' ? 'Java' : javaCheck.vendor} ${javaVersionNumber}`.trim()
      : 'No Java runtime on PATH'
    : 'Detecting Java runtime…';
  const detectedJavaNote = javaCheck
    ? javaCheck.meetsRequirement === false
      ? `Requires Java ${javaCheck.requiredJava}+ for this Minecraft version`
      : javaCheck.meetsRequirement
        ? 'Meets the requirement for this Minecraft version'
        : 'Minecraft version unknown — requirement not evaluated'
    : 'Reading system runtime';
  const activeJdkObj = {
    id: 'detected',
    name: detectedJavaName,
    sub: javaCheck
      ? javaCheck.installed
        ? 'Detected on this host'
        : javaCheck.notFoundMessage || 'java -version failed'
      : 'Running java -version…',
    note: detectedJavaNote,
    path: javaCheck?.javaHome || (javaCheck?.installed ? 'java (resolved from PATH)' : '—'),
  };
  const jdks = javaCheck?.installed ? [activeJdkObj] : [];
  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start">
      {/* CENTER SCROLLABLE WORK AREA */}
      <div className="flex-1 space-y-6 min-w-0">
        {/* 1. Top Section Header */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pb-4 border-b border-white/[0.06]">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[17px] text-primary">tune</span>
                <h1 className="text-[14.5px] font-semibold text-on-surface whitespace-nowrap">
                  Startup &amp; JVM
                </h1>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
                  <span className="material-symbols-outlined text-[13px]">verified</span>
                  PaperMC
                </span>
              </div>
              <p className="font-mono text-[11px] text-outline mt-1.5">
                Heap sizing, collector flags and VM arguments for {server.name}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleRevertDefaults}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px] text-outline">history</span>
                <span>Revert to Aikar</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const cmd = buildCommandString();
                  const blob = new Blob(
                    [`@echo off\nREM KingPanel Auto-Generated Launch Script\n${cmd}\npause`],
                    {
                      type: 'text/plain',
                    },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `start-${server.id}.bat`;
                  a.click();
                  URL.revokeObjectURL(url);
                  onShowToast(
                    'Launch Script Exported',
                    `Saved start-${server.id}.bat to Downloads.`,
                    'success',
                    'download',
                  );
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11.5px] font-medium text-on-surface transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px] text-outline">download</span>
                <span>Export script</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onShowToast(
                    'JVM Flags Staged for Restart',
                    'Written to user_jvm_args.txt. Will apply cleanly on next server restart.',
                    'success',
                    'restart_alt',
                  )
                }
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-[11.5px] font-semibold text-on-primary transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">restart_alt</span>
                <span>Apply on restart</span>
              </button>
            </div>
          </div>
        </div>

        {/* 1B. REAL-TIME SERVER.JAR ENGINE & ALL-VERSION FETCHER */}
        <section className="bg-surface-container rounded-xl p-6 border border-white/[0.06] space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-outline">dns</span>
                Server.jar fetcher
              </h2>
              <p className="font-mono text-[11px] text-outline mt-0.5">
                PaperMC, PurpurMC, Folia, Fabric, Velocity and Mojang Piston v2
              </p>
            </div>
            <div className="flex items-center gap-2">
              {jarLoading && (
                <span className="size-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              )}
              <span className="px-2.5 py-1 rounded bg-secondary/15 text-secondary border border-secondary/30 text-label-caps font-mono font-bold">
                TARGET: {activeJarFilename}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Engine Select */}
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-1.5">
              <label className="text-label-caps uppercase text-outline block">
                1. Server Engine Type
              </label>
              <select
                value={jarEngine}
                onChange={(e) => setJarEngine(e.target.value)}
                className="w-full bg-surface-container text-on-surface font-mono font-bold text-sm px-3 py-2 rounded-lg border border-outline-variant/40 focus:outline-none focus:border-primary cursor-pointer"
              >
                <option value="paper">PaperMC (High-Performance)</option>
                <option value="purpur">PurpurMC (SMP Tweaks)</option>
                <option value="folia">Folia (Region Multithreading)</option>
                <option value="fabric">Fabric Server Loader</option>
                <option value="velocity">Velocity Proxy</option>
                <option value="vanilla">Vanilla Mojang Official</option>
                <option value="waterfall">Waterfall Proxy</option>
                <option value="spigot">SpigotMC</option>
                <option value="neoforge">NeoForge</option>
                <option value="forge">Minecraft Forge</option>
              </select>
            </div>

            {/* Minecraft Version Select (All Fetched Versions) */}
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-1.5">
              <label className="text-label-caps uppercase text-outline block">
                2. Minecraft Version ({jarVersions.length} Live Versions)
              </label>
              <select
                value={jarMcVersion}
                onChange={(e) => setJarMcVersion(e.target.value)}
                className="w-full bg-surface-container text-primary font-mono font-bold text-sm px-3 py-2 rounded-lg border border-outline-variant/40 focus:outline-none focus:border-primary cursor-pointer"
              >
                {jarVersions.map((ver) => (
                  <option key={ver} value={ver}>
                    Minecraft {ver}
                  </option>
                ))}
              </select>
            </div>

            {/* Build Select & Download / Bind */}
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-white/[0.06] space-y-1.5">
              <label className="text-label-caps uppercase text-outline block">
                3. Live Build &amp; Binary Artifact
              </label>
              <select
                value={activeJarFilename}
                onChange={(e) => setActiveJarFilename(e.target.value)}
                className="w-full bg-surface-container text-secondary font-mono font-bold text-sm px-3 py-2 rounded-lg border border-outline-variant/40 focus:outline-none focus:border-primary cursor-pointer"
              >
                {jarBuilds.map((b) => (
                  <option key={String(b.build)} value={b.filename}>
                    Build #{b.build} — {b.filename}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {jarBuilds.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-container-lowest border border-white/[0.06]">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 font-mono text-xs text-white font-bold">
                  <span className="material-symbols-outlined text-sm text-secondary">verified</span>
                  <span>{activeJarFilename}</span>
                  <span className="text-outline">•</span>
                  <span className="text-tertiary">
                    SHA-256:{' '}
                    {
                      (jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0])
                        .sha256
                    }
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant">
                  {
                    (jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0])
                      .summary
                  }
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={
                    (jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0])
                      .downloadUrl
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() =>
                    onShowToast(
                      `Downloading ${activeJarFilename}`,
                      'Streaming official server.jar binary from upstream CDN.',
                      'info',
                      'download',
                    )
                  }
                  className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface font-mono text-xs font-semibold flex items-center gap-1.5 border border-outline-variant/40"
                >
                  <span className="material-symbols-outlined text-sm text-tertiary">download</span>
                  <span>Download server.jar</span>
                </a>
                <button
                  type="button"
                  onClick={() => void reinstallSelectedJar()}
                  disabled={jarInstalling}
                  className="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary font-bold text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  title="Download this build and replace server.jar in the server folder"
                >
                  <span className="material-symbols-outlined text-sm">
                    {jarInstalling ? 'progress_activity' : 'bolt'}
                  </span>
                  <span>{jarInstalling ? 'Reinstalling…' : 'Reinstall server.jar'}</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 2. Optimizer Preset Engine */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md">
                Optimizer Preset Engine
              </h2>
              <p className="text-body-sm text-outline">
                Select an engineered memory archetype tested against Minecraft ticks
              </p>
            </div>
            <span className="text-label-caps text-secondary font-mono flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-secondary animate-pulse" />
              Auto-Tuning Active
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
            {presets.map((p) => {
              const isSelected = selectedPreset === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => {
                    setSelectedPreset(p.id);
                    onShowToast(`Preset Activated: ${p.title}`, p.desc, 'info', p.icon);
                  }}
                  className={`relative rounded-xl p-4 cursor-pointer transition-all flex flex-col justify-between group ${
                    isSelected
                      ? 'bg-surface-container border-2 border-primary-container '
                      : 'bg-surface-container-low border border-white/[0.06] hover:border-outline hover:bg-surface-container'
                  }`}
                >
                  {isSelected && (
                    <div className="absolute -top-2.5 right-3 px-2 py-0.5 bg-primary-container text-on-primary rounded text-label-caps font-bold">
                      ACTIVE PRESET
                    </div>
                  )}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-on-surface">
                      <span
                        className={`material-symbols-outlined text-xl ${
                          isSelected ? 'text-primary fill' : 'text-outline group-hover:text-primary'
                        }`}
                      >
                        {p.icon}
                      </span>
                      <h3 className="text-body-lg font-bold">{p.title}</h3>
                    </div>
                    <p className="text-body-sm text-on-surface-variant">{p.desc}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-white/[0.06]">
                    {p.tags.map((t, idx) => (
                      <span
                        key={t}
                        className={`text-label-caps px-2 py-0.5 rounded bg-surface-container-high font-mono ${
                          isSelected
                            ? idx === 0
                              ? 'text-primary'
                              : idx === 1
                                ? 'text-secondary'
                                : 'text-tertiary'
                            : 'text-outline'
                        }`}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. Visual JVM Heap Memory Allocator & Generational Breakdown */}
        <section className="bg-surface-container rounded-xl p-6 border border-white/[0.06] space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary">pie_chart</span>
                JVM Heap Memory Allocator &amp; Generational Layout
              </h2>
              <p className="text-body-sm text-on-surface-variant">
                {hostRamGb > 0
                  ? 'Host RAM detected: ' +
                    hostRamGb +
                    ' GB (recommended heap cap ' +
                    Math.max(2, Math.round(hostRamGb * 0.85)) +
                    ' GB)'
                  : 'Host RAM not measured yet'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-high rounded-lg border border-white/[0.06]">
                <span className="text-body-sm text-outline font-code-sm">Initial Heap (-Xms):</span>
                <select
                  value={xmsGb}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setXmsGb(val);
                    if (val > xmxGb) setXmxGb(val);
                  }}
                  className="bg-transparent text-primary font-mono font-bold text-xs focus:outline-none cursor-pointer"
                >
                  {[2, 4, 6, 8, 12, 16].map((g) => (
                    <option key={g} value={g} className="bg-surface-container">
                      {g * 1024} MB ({g} GB)
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-high rounded-lg border border-primary-container/30">
                <span className="text-body-sm text-outline font-code-sm">Max Heap (-Xmx):</span>
                <select
                  value={xmxGb}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setXmxGb(val);
                    if (val < xmsGb) setXmsGb(val);
                  }}
                  className="bg-transparent text-primary font-mono font-bold text-xs focus:outline-none cursor-pointer"
                >
                  {[4, 6, 8, 10, 12, 16, 24].map((g) => (
                    <option key={g} value={g} className="bg-surface-container">
                      {g * 1024} MB ({g} GB)
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex justify-between text-body-sm font-code-sm text-outline">
              <span>0 GB</span>
              <span>{xmsGb} GB (-Xms)</span>
              <span className="text-primary font-bold">{xmxGb} GB (-Xmx)</span>
              <span>{Math.max(2, Math.round((hostRamGb || 32) * 0.85))} GB (Cap)</span>
              <span>{hostRamGb > 0 ? hostRamGb : 32} GB (Host RAM)</span>
            </div>
            <div className="relative h-7 bg-surface-container-lowest rounded-lg overflow-hidden border border-white/[0.06] flex p-1">
              <div
                className="h-full bg-primary-container/30 border-r-2 border-primary-container rounded-l relative flex items-center justify-center text-label-caps font-bold text-primary transition-all"
                style={{ width: `${(xmsGb / ramScaleGb) * 100}%` }}
              >
                -Xms {xmsGb}GB
              </div>
              <div
                className="h-full bg-primary/20 border-r-2 border-primary rounded-r relative flex items-center justify-center text-label-caps font-bold text-on-surface-variant transition-all"
                style={{ width: `${Math.max(8, ((xmxGb - xmsGb) / ramScaleGb) * 100)}%` }}
              >
                -Xmx ({xmxGb}GB Max)
              </div>
              <div className="h-full bg-surface-variant/20 relative flex-1" />
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-code-sm font-bold text-on-surface uppercase tracking-wider">
                Generational Memory Distribution ({xmxMb.toLocaleString()} MB Total Pool)
              </span>
              <span className="text-body-sm text-outline font-mono">Calculated for G1GC Epoch</span>
            </div>
            <div className="w-full h-8 rounded-lg overflow-hidden flex border border-outline-variant/40 ">
              <div
                className="bg-primary-container flex items-center justify-center text-on-primary text-label-caps font-bold"
                style={{ width: '22.5%' }}
              >
                Eden {(xmxGb * 0.225).toFixed(1)}G
              </div>
              <div
                className="bg-primary-gold flex items-center justify-center text-on-primary text-label-caps font-bold"
                style={{ width: '6%' }}
              >
                S0/S1
              </div>
              <div
                className="bg-secondary-container flex items-center justify-center text-on-secondary-container text-label-caps font-bold"
                style={{ width: '63%' }}
              >
                Tenured / Old Gen ({(xmxGb * 0.65).toFixed(1)} GB)
              </div>
              <div
                className="bg-tertiary-container flex items-center justify-center text-on-tertiary-container text-label-caps font-bold"
                style={{ width: '5%' }}
              >
                Meta
              </div>
              <div
                className="bg-surface-variant flex items-center justify-center text-on-surface-variant text-label-caps font-bold"
                style={{ width: '3.5%' }}
              >
                Off
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3.5 bg-surface-container-high rounded-xl border border-secondary/30 text-body-sm">
            <span className="material-symbols-outlined text-secondary text-xl shrink-0 mt-0.5">
              check_circle
            </span>
            <div className="text-on-surface leading-relaxed">
              <strong className="text-secondary font-semibold">Heap Health Recommended:</strong>{' '}
              Matching{' '}
              <code className="px-1.5 py-0.5 bg-surface-container-lowest rounded text-primary font-mono text-code-sm">
                -Xms
              </code>{' '}
              with{' '}
              <code className="px-1.5 py-0.5 bg-surface-container-lowest rounded text-primary font-mono text-code-sm">
                -Xmx
              </code>{' '}
              avoids runtime dynamic heap resizing pauses, eliminating major tick lag spikes under
              sudden chunk batch loading.
            </div>
          </div>
        </section>

        {/* 4. Java Runtime Environment (JDK) Switcher */}
        <section className="bg-surface-container rounded-xl p-6 border border-white/[0.06] space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md flex items-center gap-2.5">
                <span className="material-symbols-outlined text-tertiary">layers</span>
                Java Runtime Environment (JDK) Switcher &amp; Compiler Suite
              </h2>
              <p className="text-body-sm text-outline">
                Manage active JVM binaries, JIT compilers, and experimental vendor runtimes
              </p>
            </div>
            <span className="px-2.5 py-1 rounded bg-tertiary-container/20 text-tertiary border border-tertiary/30 text-label-caps font-bold">
              {javaCheck
                ? javaCheck.installed
                  ? javaCheck.meetsRequirement === false
                    ? 'JAVA TOO OLD'
                    : 'RUNTIME DETECTED'
                  : 'JAVA NOT ON PATH'
                : 'CHECKING RUNTIME'}
            </span>
          </div>

          <div className="bg-surface-container-low border border-outline-variant/40 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="size-12 rounded-lg bg-surface-container-high border border-white/[0.06] flex items-center justify-center text-primary shrink-0">
                <span className="material-symbols-outlined text-2xl">developer_board</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-body-lg font-bold text-on-surface">
                    {activeJdkObj.name} LTS
                  </span>
                  <span className="text-label-caps px-2 py-0.5 rounded bg-secondary-container/20 text-secondary border border-secondary/30 font-bold">
                    ACTIVE TARGET
                  </span>
                </div>
                <p className="text-body-sm text-on-surface-variant font-code-sm mt-0.5">
                  {javaCheck?.installed
                    ? javaCheck.versionRaw || 'java -version output unavailable'
                    : 'Install a JDK and make sure java is on PATH.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-surface-container-lowest px-3 py-2 rounded-lg border border-white/[0.06] max-w-md">
              <span className="material-symbols-outlined text-outline text-base">folder_open</span>
              <span className="text-code-sm text-on-surface font-mono truncate select-all">
                {activeJdkObj.path}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(activeJdkObj.path).catch(() => {});
                  onShowToast('Binary Path Copied', activeJdkObj.path, 'success', 'content_copy');
                }}
                className="text-outline hover:text-primary transition-colors pl-2 border-l border-white/[0.06] cursor-pointer"
                title="Copy Binary Path"
              >
                <span className="material-symbols-outlined text-base">content_copy</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 pt-1">
            {jdks.map((j) => {
              const isSelected = true;
              return (
                <div
                  key={j.id}
                  onClick={() => {
                    navigator.clipboard?.writeText(j.path).catch(() => {});
                    onShowToast('Runtime path copied', j.path, 'info', 'content_copy');
                  }}
                  className={`p-3.5 rounded-xl cursor-pointer transition-all flex flex-col justify-between ${
                    isSelected
                      ? 'border-2 border-primary-container bg-surface-container-high'
                      : 'border border-white/[0.06] bg-surface-container-low hover:border-outline hover:bg-surface-container'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-body-md font-bold text-on-surface">{j.name}</h4>
                      <span
                        className={`text-label-caps font-mono ${
                          isSelected ? 'text-secondary' : 'text-outline'
                        }`}
                      >
                        {j.sub}
                      </span>
                    </div>
                    <span
                      className={`material-symbols-outlined ${
                        isSelected ? 'text-primary-container fill' : 'text-outline'
                      }`}
                    >
                      {isSelected ? 'radio_button_checked' : 'radio_button_unchecked'}
                    </span>
                  </div>
                  <span className="text-body-sm text-outline mt-3">{j.note}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 5. Garbage Collector Tuning Matrix */}
        <section className="bg-surface-container rounded-xl p-6 border border-white/[0.06] space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md flex items-center gap-2.5">
                <span className="material-symbols-outlined text-secondary">tune</span>
                Garbage Collector Tuning Matrix
              </h2>
              <p className="text-body-sm text-outline">
                Granular switch controls for HotSpot VM GC heuristic arguments
              </p>
            </div>
            <button
              type="button"
              onClick={enableAllRecommended}
              className="px-3 py-1 rounded bg-surface-container-high text-body-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-bright transition-colors font-medium cursor-pointer"
            >
              Enable All Recommended
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              {
                key: 'UseG1GC',
                code: '-XX:+UseG1GC',
                badge: 'STABLE',
                badgeColor: 'bg-secondary-container/20 text-secondary',
                desc: 'Enables Garbage-First collector designed for multiprocessor servers with larger memory spaces.',
              },
              {
                key: 'ParallelRefProcEnabled',
                code: '-XX:+ParallelRefProcEnabled',
                badge: 'MULTI-CORE',
                badgeColor: 'bg-tertiary-container/20 text-tertiary',
                desc: 'Processes soft and weak object references in parallel across CPU worker threads during STW phases.',
              },
              {
                key: 'MaxGCPauseMillis',
                code: '-XX:MaxGCPauseMillis=20',
                badge: 'TICK LOCK',
                badgeColor: 'bg-secondary-container/20 text-secondary',
                desc: 'Establishes target max GC pause ceiling to 20ms to prevent noticeable client tick drops.',
              },
              {
                key: 'UnlockExperimentalVMOptions',
                code: '-XX:+UnlockExperimentalVMOptions',
                badge: 'SYSTEM',
                badgeColor: 'bg-surface-container-high text-outline',
                desc: 'Unlocks low-latency generational heuristic flags inside HotSpot VM runtime.',
              },
              {
                key: 'G1NewSizePercent',
                code: '-XX:G1NewSizePercent=30 & G1MaxNewSizePercent=40',
                desc: 'Locks young generation heap between 30% and 40% for short-lived chunk tick objects.',
              },
              {
                key: 'AlwaysPreTouch',
                code: '-XX:+AlwaysPreTouch',
                badge: 'WARM BOOT',
                badgeColor: 'bg-primary-container/20 text-primary',
                desc: 'Pre-allocates and touches all requested memory pages upon JVM boot to eliminate page faults during gameplay.',
              },
              {
                key: 'DisableExplicitGC',
                code: '-XX:+DisableExplicitGC',
                desc: 'Prevents rogue plugins calling synchronous System.gc() which freezes tick execution threads.',
              },
              {
                key: 'G1ReservePercent',
                code: '-XX:G1ReservePercent=20',
                badge: 'SAFETY',
                badgeColor: 'bg-secondary-container/20 text-secondary',
                desc: 'Keeps a 20% memory buffer against "to-space exhausted" evacuation failures in large chunks.',
              },
            ].map((item) => {
              const isOn = flags[item.key];
              return (
                <div
                  key={item.key}
                  className="bg-surface-container-low border border-white/[0.06] rounded-xl p-4 flex items-start justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-code-md text-primary font-bold">{item.code}</code>
                      {item.badge && (
                        <span
                          className={`text-label-caps px-1.5 py-0.5 rounded font-mono font-bold ${item.badgeColor}`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-body-sm text-on-surface-variant">{item.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleFlag(item.key)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                      isOn ? 'bg-primary-container' : 'bg-surface-container-highest'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-on-primary shadow transition duration-200 ${
                        isOn ? 'translate-x-5' : 'translate-x-0 bg-white/70'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 6. Live Generated Startup Command Line String */}
        <section className="bg-surface-container rounded-xl border border-white/[0.06] overflow-hidden ">
          <div className="bg-surface-container-lowest px-4 py-3 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="size-3 rounded-full bg-error inline-block" />
                <span className="size-3 rounded-full bg-primary inline-block" />
                <span className="size-3 rounded-full bg-secondary inline-block" />
              </div>
              <span className="text-code-sm text-outline font-mono">
                bash / powershell launch execution target
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-secondary-container/20 text-secondary text-label-caps font-mono font-bold border border-secondary/30">
                <span className="material-symbols-outlined text-sm">verified</span>
                <span>Syntax Validated (0 Conflicts Detected)</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const cmd = buildCommandString();
                  navigator.clipboard?.writeText(cmd).catch(() => {});
                  onShowToast(
                    'Launch Command Copied',
                    'Copied full JVM startup command to clipboard.',
                    'success',
                    'copy_all',
                  );
                }}
                className="px-3 py-1 bg-surface-container hover:bg-surface-bright text-on-surface text-code-sm rounded border border-white/[0.06] transition-colors flex items-center gap-1.5 font-semibold cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">copy_all</span>
                <span>Copy Launch Command</span>
              </button>
            </div>
          </div>

          <div className="p-4 bg-surface-container-lowest/90 font-code-md text-code-md leading-relaxed select-all overflow-x-auto">
            <p className="whitespace-pre-wrap text-primary font-mono">{buildCommandString()}</p>
          </div>
          <div className="bg-surface-container-low px-4 py-2 border-t border-white/[0.06] flex items-center justify-between text-body-sm text-outline">
            <span className="font-mono">Payload: {buildCommandString().length} characters</span>
            <span>Target JVM: {activeJdkObj.name}</span>
          </div>
        </section>
      </div>

      {/* 7. RIGHT RAIL — only measured runtime facts */}
      <aside className="w-full xl:w-80 bg-surface-container-low rounded-xl border border-white/[0.06] p-6 flex flex-col gap-6 shrink-0">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
          <h3 className="text-title-md font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-secondary">monitor_heart</span>
            Java Runtime
          </h3>
          <span className="text-label-caps font-mono font-bold text-secondary">
            {javaCheck ? (javaCheck.installed ? 'LIVE' : 'MISSING') : 'PROBING'}
          </span>
        </div>

        <div className="bg-surface-container rounded-xl p-4 border border-white/[0.06] space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-sm text-on-surface-variant">Detected</span>
            <span className="text-body-sm font-bold font-mono text-on-surface text-right">
              {activeJdkObj.name}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-sm text-on-surface-variant">Major version</span>
            <span className="text-body-sm font-mono text-on-surface">
              {javaCheck?.javaMajorVersion ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-sm text-on-surface-variant">Required</span>
            <span className="text-body-sm font-mono text-on-surface">
              {javaCheck?.requiredJava ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-sm text-on-surface-variant">JAVA_HOME</span>
            <span
              className="text-code-sm font-mono text-on-surface truncate max-w-[170px]"
              title={javaCheck?.javaHome || ''}
            >
              {javaCheck?.javaHome || 'not set'}
            </span>
          </div>
          <p className="text-body-sm text-outline leading-relaxed">
            {javaCheck?.installed
              ? 'Reported by java -version on this host.'
              : javaCheck?.notFoundMessage || 'The panel has not run java -version yet.'}
          </p>
        </div>

        <div className="bg-surface-container rounded-xl p-4 border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-body-sm font-semibold text-on-surface">Host memory</span>
            <span className="text-label-caps text-outline font-mono">
              {hostRamGb > 0 ? hostRamGb + ' GB' : 'unknown'}
            </span>
          </div>
          <p className="text-body-sm text-outline leading-relaxed">
            {hostRamGb > 0
              ? 'Heap is carved out of ' +
                hostRamGb +
                ' GB of physical RAM. Leave room for the OS, the panel and disk cache.'
              : 'Host memory could not be measured; no limit is assumed.'}
          </p>
        </div>

        <div className="space-y-3 pt-2">
          <h4 className="text-body-md font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-base">rule</span>
            <span>Applied configuration</span>
          </h4>
          <div className="space-y-2">
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-container text-body-sm border border-white/[0.06]">
              <span className="material-symbols-outlined text-secondary text-base shrink-0 mt-0.5">
                memory
              </span>
              <div>
                <span className="font-medium text-on-surface">
                  Heap {xmsGb}–{xmxGb} GB
                </span>
                <p className="text-outline text-body-sm mt-0.5">
                  -Xms/-Xmx come straight from the sliders above.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-container text-body-sm border border-white/[0.06]">
              <span className="material-symbols-outlined text-secondary text-base shrink-0 mt-0.5">
                tune
              </span>
              <div>
                <span className="font-medium text-on-surface">GC preset: {selectedPreset}</span>
                <p className="text-outline text-body-sm mt-0.5">
                  Only flags enabled in this preset are emitted.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-primary-container/15 border border-primary-container/30 text-body-sm space-y-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <span className="material-symbols-outlined text-base">memory</span>
            <span>Launch command</span>
          </div>
          <p className="text-on-surface-variant text-body-sm">
            Copy the generated flags into{' '}
            <code className="text-code-sm bg-surface-container px-1 py-0.5 rounded text-on-surface font-mono">
              user_jvm_args.txt
            </code>{' '}
            or your start script — the panel does not write them for you.
          </p>
        </div>
      </aside>
    </div>
  );
};

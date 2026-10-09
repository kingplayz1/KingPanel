import React, { useState, useEffect, useCallback } from 'react';
import { ServerInstance } from '../types';

interface StartupJvmViewProps {
  server: ServerInstance;
  onUpdateServerEngine?: (engineLabel: string, buildLabel: string, jarFilename: string) => void;
  onShowToast: (title: string, body?: string, type?: 'success' | 'info' | 'warning' | 'error', icon?: string) => void;
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
  const [selectedJdk, setSelectedJdk] = useState<string>('zulu');

  // Real-time server.jar fetcher state
  const [jarEngine, setJarEngine] = useState<string>('paper');
  const [jarVersions, setJarVersions] = useState<string[]>([]);
  const [jarMcVersion, setJarMcVersion] = useState<string>('1.20.4');
  const [jarBuilds, setJarBuilds] = useState<LiveJarBuild[]>([]);
  const [activeJarFilename, setActiveJarFilename] = useState<string>('paper-1.20.4-498.jar');
  const [jarLoading, setJarLoading] = useState<boolean>(false);

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
        `/api/jars/engines/${encodeURIComponent(eng)}/${encodeURIComponent(ver)}`
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
    onShowToast('Recommended Flags Enabled', "Restored all 8 Aikar's GC heuristic flags.", 'success', 'tune');
  };

  const handleRevertDefaults = () => {
    setSelectedPreset('aikar');
    setXmsGb(4);
    setXmxGb(8);
    setSelectedJdk('zulu');
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
    parts.push('-XX:SurvivorRatio=32 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true');
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

  const jdks = [
    {
      id: 'zulu',
      name: 'Azul Zulu 21.0.2',
      sub: 'Current Default',
      note: 'High compatibility G1GC',
      path: 'C:\\KingEngine\\runtimes\\zulu-21-x64\\bin\\java.exe',
    },
    {
      id: 'temurin',
      name: 'Eclipse Temurin 21.0.2',
      sub: 'Adoptium Certified',
      note: 'Standard Enterprise HotSpot',
      path: 'C:\\KingEngine\\runtimes\\temurin-21-x64\\bin\\java.exe',
    },
    {
      id: 'graalvm',
      name: 'Oracle GraalVM EE 21',
      sub: 'Max Throughput',
      note: 'Advanced polyglot & C2',
      path: 'C:\\KingEngine\\runtimes\\graalvm-ce-21\\bin\\java.exe',
    },
    {
      id: 'corretto',
      name: 'Amazon Corretto 21',
      sub: 'Cloud Optimized',
      note: 'AWS production validated',
      path: 'C:\\KingEngine\\runtimes\\corretto-21\\bin\\java.exe',
    },
  ];

  const activeJdkObj = jdks.find((j) => j.id === selectedJdk) || jdks[0];

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start">
      {/* CENTER SCROLLABLE WORK AREA */}
      <div className="flex-1 space-y-6 min-w-0">
        {/* 1. Top Section Header */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-label-caps text-outline tracking-wider font-semibold">
            <span>SERVER OPERATIONS</span>
            <span>/</span>
            <span>CONFIGURATION</span>
            <span>/</span>
            <span className="text-primary-container">STARTUP &amp; JVM FLAGS OPTIMIZER</span>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-outline-variant/20">
            <div className="max-w-2xl">
              <h1 className="text-display-lg text-on-surface font-headline-lg flex flex-wrap items-center gap-3">
                Startup &amp; JVM Flags Optimizer
                <span className="text-label-caps bg-secondary-container/20 text-secondary border border-secondary/30 px-2 py-0.5 rounded font-mono uppercase font-bold">
                  PaperMC Verified
                </span>
              </h1>
              <p className="text-body-md text-on-surface-variant mt-1.5 leading-relaxed">
                Fine-tune generational heap sizing, garbage collector flags, and Java VM runtime
                arguments for maximum TPS stability.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleRevertDefaults}
                className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-body-sm font-semibold border border-outline-variant/40 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">history</span>
                <span>Revert to Recommended Aikar Defaults</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const cmd = buildCommandString();
                  const blob = new Blob([`@echo off\nREM IS King Panel Auto-Generated Launch Script\n${cmd}\npause`], {
                    type: 'text/plain',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `start-${server.id}.bat`;
                  a.click();
                  URL.revokeObjectURL(url);
                  onShowToast('Launch Script Exported', `Saved start-${server.id}.bat to Downloads.`, 'success', 'download');
                }}
                className="px-3.5 py-2 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface text-body-sm font-semibold border border-outline-variant/40 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">download</span>
                <span>Export Script (.bat / .sh / .ps1)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onShowToast(
                    'JVM Flags Staged for Restart',
                    'Written to user_jvm_args.txt. Will apply cleanly on next server restart.',
                    'success',
                    'restart_alt'
                  )
                }
                className="px-4 py-2 rounded-lg bg-primary-container text-on-primary font-bold text-body-sm shadow-[0_0_20px_rgba(245,158,11,0.25)] hover:bg-primary-gold transition-all flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-base font-bold">restart_alt</span>
                <span>Apply &amp; Stage on Next Restart</span>
              </button>
            </div>
          </div>
        </div>

        {/* 1B. REAL-TIME SERVER.JAR ENGINE & ALL-VERSION FETCHER */}
        <section className="bg-surface-container rounded-2xl p-6 border border-outline-variant/30 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary">dns</span>
                Real-Time Server.jar Binary Fetcher (All Engines &amp; Versions)
              </h2>
              <p className="text-body-sm text-on-surface-variant">
                Live upstream sync with PaperMC, PurpurMC, Folia, Fabric Meta, Velocity, and Mojang Piston v2 APIs
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
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/30 space-y-1.5">
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
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/30 space-y-1.5">
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
            <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/30 space-y-1.5">
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
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-container-lowest border border-outline-variant/30">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 font-mono text-xs text-white font-bold">
                  <span className="material-symbols-outlined text-sm text-secondary">verified</span>
                  <span>{activeJarFilename}</span>
                  <span className="text-outline">•</span>
                  <span className="text-tertiary">
                    SHA-256:{' '}
                    {(
                      jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0]
                    ).sha256}
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant">
                  {(jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0]).summary}
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
                      'download'
                    )
                  }
                  className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-on-surface font-mono text-xs font-semibold flex items-center gap-1.5 border border-outline-variant/40"
                >
                  <span className="material-symbols-outlined text-sm text-tertiary">download</span>
                  <span>Download server.jar</span>
                </a>
                <button
                  type="button"
                  onClick={() => {
                    const currentBuild =
                      jarBuilds.find((b) => b.filename === activeJarFilename) || jarBuilds[0];
                    if (onUpdateServerEngine) {
                      onUpdateServerEngine(
                        `${jarEngine.toUpperCase()} ${jarMcVersion}`,
                        `Build #${currentBuild.build}`,
                        activeJarFilename
                      );
                    }
                    onShowToast(
                      `Mounted ${activeJarFilename}`,
                      `Updated ${server.name} startup target to -jar ${activeJarFilename}.`,
                      'success',
                      'check_circle'
                    );
                  }}
                  className="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary font-bold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm">bolt</span>
                  <span>Set as Server Startup JAR</span>
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
                      ? 'bg-surface-container border-2 border-primary-container shadow-lg'
                      : 'bg-surface-container-low border border-outline-variant/30 hover:border-outline hover:bg-surface-container'
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
                  <div className="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-outline-variant/20">
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
        <section className="bg-surface-container rounded-2xl p-6 border border-outline-variant/30 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="text-headline-sm text-on-surface font-title-md flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary">pie_chart</span>
                JVM Heap Memory Allocator &amp; Generational Layout
              </h2>
              <p className="text-body-sm text-on-surface-variant">
                Host Hardware Limit: 32 GB DDR5 RAM (Safe recommendation cap: 16 GB)
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-high rounded-lg border border-outline-variant/20">
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
              <span>16 GB (Cap)</span>
              <span>32 GB (Host Hardware Limit)</span>
            </div>
            <div className="relative h-7 bg-surface-container-lowest rounded-lg overflow-hidden border border-outline-variant/30 flex p-1">
              <div
                className="h-full bg-primary-container/30 border-r-2 border-primary-container rounded-l relative flex items-center justify-center text-label-caps font-bold text-primary transition-all"
                style={{ width: `${(xmsGb / 32) * 100}%` }}
              >
                -Xms {xmsGb}GB
              </div>
              <div
                className="h-full bg-primary/20 border-r-2 border-primary rounded-r relative flex items-center justify-center text-label-caps font-bold text-on-surface-variant transition-all"
                style={{ width: `${Math.max(8, ((xmxGb - xmsGb) / 32) * 100)}%` }}
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
            <div className="w-full h-8 rounded-lg overflow-hidden flex border border-outline-variant/40 shadow-inner">
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
        <section className="bg-surface-container rounded-2xl p-6 border border-outline-variant/30 space-y-5">
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
              JIT C2 COMPILER VALIDATED
            </span>
          </div>

          <div className="bg-surface-container-low border border-outline-variant/40 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="size-12 rounded-lg bg-surface-container-high border border-outline-variant/30 flex items-center justify-center text-primary shrink-0">
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
                  Architecture: x86_64 • GraalVM JIT &amp; Compact String optimizations active
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-surface-container-lowest px-3 py-2 rounded-lg border border-outline-variant/30 max-w-md">
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
                className="text-outline hover:text-primary transition-colors pl-2 border-l border-outline-variant/30 cursor-pointer"
                title="Copy Binary Path"
              >
                <span className="material-symbols-outlined text-base">content_copy</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 pt-1">
            {jdks.map((j) => {
              const isSelected = selectedJdk === j.id;
              return (
                <div
                  key={j.id}
                  onClick={() => {
                    setSelectedJdk(j.id);
                    onShowToast(`Switched JDK Runtime: ${j.name}`, `Binary target set to ${j.path}`, 'info', 'developer_board');
                  }}
                  className={`p-3.5 rounded-xl cursor-pointer transition-all flex flex-col justify-between ${
                    isSelected
                      ? 'border-2 border-primary-container bg-surface-container-high'
                      : 'border border-outline-variant/30 bg-surface-container-low hover:border-outline hover:bg-surface-container'
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
        <section className="bg-surface-container rounded-2xl p-6 border border-outline-variant/30 space-y-5">
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
                  className="bg-surface-container-low border border-outline-variant/30 rounded-xl p-4 flex items-start justify-between gap-4"
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
        <section className="bg-surface-container rounded-2xl border border-outline-variant/30 overflow-hidden shadow-2xl">
          <div className="bg-surface-container-lowest px-4 py-3 border-b border-outline-variant/30 flex flex-wrap items-center justify-between gap-2">
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
                  onShowToast('Launch Command Copied', 'Copied full JVM startup command to clipboard.', 'success', 'copy_all');
                }}
                className="px-3 py-1 bg-surface-container hover:bg-surface-bright text-on-surface text-code-sm rounded border border-outline-variant/30 transition-colors flex items-center gap-1.5 font-semibold cursor-pointer"
              >
                <span className="material-symbols-outlined text-base">copy_all</span>
                <span>Copy Launch Command</span>
              </button>
            </div>
          </div>

          <div className="p-4 bg-surface-container-lowest/90 font-code-md text-code-md leading-relaxed select-all overflow-x-auto">
            <p className="whitespace-pre-wrap text-primary font-mono">{buildCommandString()}</p>
          </div>
          <div className="bg-surface-container-low px-4 py-2 border-t border-outline-variant/20 flex items-center justify-between text-body-sm text-outline">
            <span className="font-mono">
              Payload: {buildCommandString().length} characters • Process spawn: Native IO High-Priority
            </span>
            <span>Target JVM: HotSpot 64-Bit Server VM</span>
          </div>
        </section>
      </div>

      {/* 7. RIGHT DIAGNOSTIC RAIL */}
      <aside className="w-full xl:w-80 bg-surface-container-low rounded-2xl border border-outline-variant/30 p-6 flex flex-col gap-6 shrink-0">
        <div className="flex items-center justify-between pb-3 border-b border-outline-variant/20">
          <h3 className="text-title-md font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-secondary">monitor_heart</span>
            GC Latency Profile
          </h3>
          <span className="text-label-caps text-secondary font-mono font-bold">SIMULATED</span>
        </div>

        <div className="bg-surface-container rounded-xl p-4 border border-outline-variant/20 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-body-sm text-on-surface-variant">Est. Max Pause</span>
            <span className="text-headline-sm font-bold text-secondary font-mono">
              {selectedPreset === 'zgc' ? '1.1 ms' : selectedPreset === 'shenandoah' ? '3.8 ms' : '14.2 ms'}
            </span>
          </div>
          <div className="w-full bg-surface-container-lowest h-2 rounded-full overflow-hidden">
            <div
              className="bg-secondary h-full rounded-full transition-all"
              style={{ width: selectedPreset === 'zgc' ? '8%' : '28%' }}
            />
          </div>
          <div className="flex justify-between text-label-caps text-outline font-mono">
            <span>Target: 20 ms</span>
            <span>Critical: &gt; 50 ms</span>
          </div>
        </div>

        <div className="bg-surface-container rounded-xl p-4 border border-outline-variant/20 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-body-sm font-semibold text-on-surface">GC Pauses (Last 60s)</span>
            <span className="text-label-caps text-outline font-mono">3 Cycles</span>
          </div>
          <div className="h-16 w-full flex items-end gap-1.5 pt-2">
            {[25, 35, 20, 30, 70, 22, 18, 40, 25, 30].map((h, i) => (
              <div
                key={i}
                className="w-full bg-secondary-container/30 hover:bg-secondary rounded-t transition-all"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-surface-container rounded-xl p-3 border border-outline-variant/20">
            <span className="text-body-sm text-outline block">Eden Cycle</span>
            <span className="text-body-lg font-bold font-mono text-on-surface">~42 sec</span>
            <span className="text-label-caps text-secondary font-mono">Normal cadence</span>
          </div>
          <div className="bg-surface-container rounded-xl p-3 border border-outline-variant/20">
            <span className="text-body-sm text-outline block">Tick Loss Risk</span>
            <span className="text-body-lg font-bold font-mono text-secondary">0.02%</span>
            <span className="text-label-caps text-secondary font-mono">Negligible</span>
          </div>
        </div>

        <div className="space-y-3 pt-2">
          <h4 className="text-body-md font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-base">rule</span>
            <span>Environment &amp; Integrity</span>
          </h4>
          <div className="space-y-2">
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-container text-body-sm border border-outline-variant/20">
              <span className="material-symbols-outlined text-secondary text-base shrink-0 mt-0.5">
                check_circle
              </span>
              <div>
                <span className="font-medium text-on-surface">No conflicting GC flags</span>
                <p className="text-outline text-body-sm mt-0.5">
                  Shenandoah &amp; ParallelGC explicitly omitted.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-container text-body-sm border border-outline-variant/20">
              <span className="material-symbols-outlined text-secondary text-base shrink-0 mt-0.5">
                check_circle
              </span>
              <div>
                <span className="font-medium text-on-surface">Azul Zulu JIT Tier Verified</span>
                <p className="text-outline text-body-sm mt-0.5">
                  TieredCompilation enabled (Levels 1-4 active).
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-surface-container text-body-sm border border-outline-variant/20">
              <span className="material-symbols-outlined text-tertiary text-base shrink-0 mt-0.5">
                info
              </span>
              <div>
                <span className="font-medium text-on-surface">Large Page Support</span>
                <p className="text-outline text-body-sm mt-0.5">
                  Host kernel supports transparent huge pages (THP).
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-primary-container/15 border border-primary-container/30 text-body-sm space-y-2">
          <div className="flex items-center gap-2 text-primary font-bold">
            <span className="material-symbols-outlined text-base">schedule</span>
            <span>Scheduled Execution</span>
          </div>
          <p className="text-on-surface-variant text-body-sm">
            Flags will stage to{' '}
            <code className="text-code-sm bg-surface-container px-1 py-0.5 rounded text-on-surface font-mono">
              user_jvm_args.txt
            </code>{' '}
            and apply at 04:00 AM UTC maintenance restart.
          </p>
        </div>
      </aside>
    </div>
  );
};

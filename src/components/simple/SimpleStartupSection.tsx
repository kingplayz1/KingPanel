import React, { useCallback, useEffect, useState } from 'react';
import { cancelJob, submitJob, type OperationJob } from '../../lib/jobs';
import { JobProgressBar } from '../JobProgressBar';
import { SectionProps, cardClass, cardTitleClass, ghostBtnClass, inputClass, primaryBtnClass } from './types';

/**
 * Startup tab: the JVM command the panel spawns, the main jar, extra arguments
 * and the "server image" — the Java runtime check for the chosen MC version.
 */

interface SetupPayload {
  startupCommand: string;
  mainFile: string;
  additionalArguments: string;
  additionalFlags: string;
  javaPath: string;
  engine?: string;
  version?: string;
}

interface JavaCheck {
  installed: boolean;
  versionRaw: string;
  vendor: string;
  javaMajorVersion: number | null;
  javaHome: string;
  requiredJava: number | null;
  meetsRequirement: boolean | null;
  notFoundMessage?: string;
}

interface SimpleStartupSectionProps extends SectionProps {
  containerVersion?: string;
  containerEngine?: string;
}

export const SimpleStartupSection: React.FC<SimpleStartupSectionProps> = ({
  server,
  onShowToast,
  containerVersion,
  containerEngine,
}) => {
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [java, setJava] = useState<JavaCheck | null>(null);
  const [checkingJava, setCheckingJava] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [jarJob, setJarJob] = useState<OperationJob | null>(null);

  const query = `serverId=${encodeURIComponent(server.id)}&serverName=${encodeURIComponent(
    server.name
  )}&ramMaxGb=${server.ramMaxGb}`;

  const loadSetup = useCallback(async () => {
    try {
      const res = await fetch(`/api/server-runtime/setup?${query}`);
      const data = await res.json();
      if (data?.ok) setSetup(data.setup as SetupPayload);
    } catch {
      // backend restarting
    }
  }, [query]);

  const checkJava = useCallback(async () => {
    setCheckingJava(true);
    try {
      const res = await fetch(
        `/api/server-runtime/java-check?${query}&version=${encodeURIComponent(
          containerVersion || ''
        )}`
      );
      const data = await res.json();
      if (data?.ok) setJava(data as JavaCheck);
    } catch {
      // backend restarting
    } finally {
      setCheckingJava(false);
    }
  }, [query, containerVersion]);

  useEffect(() => {
    void loadSetup();
    void checkJava();
  }, [loadSetup, checkJava]);

  const save = async () => {
    if (!setup) return;
    setSaving(true);
    try {
      const res = await fetch('/api/server-runtime/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: server.id, setup }),
      });
      const data = await res.json();
      if (!data?.ok) {
        onShowToast('Could not save startup', data?.error, 'error');
        return;
      }
      onShowToast('Startup settings saved', 'Applied the next time the server starts', 'success', 'rocket_launch');
    } finally {
      setSaving(false);
    }
  };

  const reinstallJar = async () => {
    setInstalling(true);
    setJarJob(null);
    try {
      // Runs as a background job so a slow download reports progress and can be
      // cancelled instead of hanging on one long request.
      const outcome = await submitJob<Record<string, any>>(
        '/api/server-runtime/install-jar',
        {
          serverId: server.id,
          serverName: server.name,
          // Fall back to the container's recorded engine so a server whose setup
          // map entry is missing can still be repaired from Startup.
          engine: containerEngine || undefined,
          version: containerVersion || undefined,
        },
        { onProgress: setJarJob },
      );
      const data = (outcome.result || {}) as Record<string, any>;
      if (!outcome.ok) {
        onShowToast('Jar install failed', outcome.error || 'The download did not finish', 'error', 'error');
        return;
      }
      onShowToast(
        'server.jar reinstalled',
        `${data.filename || 'server.jar'} · ${((data.bytes || 0) / 1024 / 1024).toFixed(1)} MB` +
          ` · written to ${server.name}`,
        'success',
        'download_done'
      );
      await loadSetup();
    } finally {
      setInstalling(false);
    }
  };

  const javaOk = java?.meetsRequirement === true;
  const javaBad = java?.meetsRequirement === false;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${cardClass} lg:col-span-2`}>
          <h2 className={`${cardTitleClass} mb-3`}>
            <span className="material-symbols-outlined text-[18px] text-primary">terminal</span>
            Startup command
          </h2>
          {setup ? (
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-bold text-outline uppercase tracking-wider">
                  Startup command
                </label>
                <textarea
                  value={setup.startupCommand}
                  onChange={(e) => setSetup({ ...setup, startupCommand: e.target.value })}
                  rows={2}
                  spellCheck={false}
                  className={`${inputClass} mt-1 resize-none`}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-outline uppercase tracking-wider">Main file</label>
                  <input
                    value={setup.mainFile}
                    onChange={(e) => setSetup({ ...setup, mainFile: e.target.value })}
                    placeholder="server.jar"
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-outline uppercase tracking-wider">
                    Additional arguments
                  </label>
                  <input
                    value={setup.additionalArguments}
                    onChange={(e) => setSetup({ ...setup, additionalArguments: e.target.value })}
                    placeholder="--nogui"
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-outline uppercase tracking-wider">JVM arguments</label>
                  <input
                    value={setup.additionalFlags}
                    onChange={(e) => setSetup({ ...setup, additionalFlags: e.target.value })}
                    placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8"
                    className={`${inputClass} mt-1`}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-outline uppercase tracking-wider">
                    Java executable (optional)
                  </label>
                  <input
                    value={setup.javaPath}
                    onChange={(e) => setSetup({ ...setup, javaPath: e.target.value })}
                    placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
                    className={`${inputClass} mt-1`}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void save()} disabled={saving} className={primaryBtnClass}>
                  <span className="material-symbols-outlined text-[16px]">save</span>
                  {saving ? 'Saving…' : 'Save startup'}
                </button>
                <button type="button" onClick={() => void loadSetup()} className={ghostBtnClass}>
                  <span className="material-symbols-outlined text-[16px]">undo</span>
                  Reload
                </button>
                <span className="text-[11px] text-outline">
                  Engine: <span className="font-mono text-white">{containerEngine || 'unknown'}</span> · version{' '}
                  <span className="font-mono text-white">{containerVersion || '—'}</span>
                </span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-outline">Loading startup settings…</p>
          )}
        </div>

        <div className={cardClass}>
          <h2 className={`${cardTitleClass} mb-2`}>
            <span className="material-symbols-outlined text-[18px] text-primary">memory</span>
            Server image · Java
          </h2>
          <div
            className={`rounded-xl border px-3 py-2.5 mb-2 ${
              javaOk
                ? 'border-secondary/40 bg-secondary/10'
                : javaBad
                  ? 'border-error/40 bg-error/10'
                  : 'border-white/10 bg-surface-lowest'
            }`}
          >
            <p className="text-[10px] uppercase tracking-wider text-outline font-bold">Installed runtime</p>
            <p className="text-xs font-mono text-white break-all">
              {checkingJava && !java ? 'Checking java -version…' : java?.versionRaw || 'Java not detected'}
            </p>
            <p className="text-[11px] text-outline mt-0.5">
              {java?.installed
                ? `${java.vendor} · Java ${java.javaMajorVersion ?? '?'}`
                : java?.notFoundMessage || 'Install a JDK and restart the panel.'}
            </p>
          </div>
          <dl className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-outline">Required for {containerVersion || 'this version'}</dt>
              <dd className="font-mono text-white">{java?.requiredJava ? `Java ${java.requiredJava}+` : '—'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-outline">Compatibility</dt>
              <dd className={javaOk ? 'text-secondary font-bold' : javaBad ? 'text-error font-bold' : 'text-outline'}>
                {javaOk ? 'OK' : javaBad ? 'UPGRADE NEEDED' : 'UNKNOWN'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-outline shrink-0">JAVA_HOME</dt>
              <dd className="font-mono text-white truncate max-w-[190px]" title={java?.javaHome}>
                {java?.javaHome || 'not set'}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button type="button" onClick={() => void checkJava()} disabled={checkingJava} className={ghostBtnClass}>
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              {checkingJava ? 'Checking…' : 'Recheck Java'}
            </button>
            <button type="button" onClick={() => void reinstallJar()} disabled={installing} className={ghostBtnClass}>
              <span className="material-symbols-outlined text-[16px]">download</span>
              {installing ? 'Downloading…' : 'Reinstall server.jar'}
            </button>
          </div>
          {installing && jarJob && (
            <JobProgressBar
              job={jarJob}
              className="mt-2"
              onCancel={() => {
                void cancelJob(jarJob.id);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

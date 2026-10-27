import React, { useCallback, useEffect, useState } from 'react';

interface DiscordAccessSettingsProps {
  isSuperAdmin: boolean;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

interface RuntimeDiscordConfig {
  guildId: string;
  guildName: string;
  inviteUrl: string;
  advancedPanelRoleId: string;
}

type DiagnosticResult =
  | 'ok'
  | 'role_missing'
  | 'not_a_member'
  | 'reconnect_required'
  | 'unavailable'
  | 'not_configured';

interface DiagnosticReport {
  result: DiagnosticResult;
  message: string;
  roles?: string[];
  rolePresent?: boolean;
  guildName?: string;
  checkedAt?: string;
}

const isSnowflake = (value: string) => /^\d{17,20}$/.test(value.trim());

/**
 * Super Admin settings for the Discord gate: which guild is checked, which role
 * unlocks the Advanced Panel and where the Join button points. Saved through
 * POST /api/auth/discord/config, which persists to `.local-discord-config.json`
 * and overrides the `.env` defaults on the next boot. Express re-checks that the
 * caller is a Super Admin; this card only hides the form.
 */
export const DiscordAccessSettings: React.FC<DiscordAccessSettingsProps> = ({
  isSuperAdmin,
  onShowToast,
}) => {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<RuntimeDiscordConfig | null>(null);
  const [guildId, setGuildId] = useState('');
  const [guildName, setGuildName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);

  const applyConfig = useCallback((config: RuntimeDiscordConfig) => {
    setSaved(config);
    setGuildId(config.guildId || '');
    setGuildName(config.guildName || '');
    setRoleId(config.advancedPanelRoleId || '');
    setInviteUrl(config.inviteUrl || '');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, urlRes] = await Promise.all([
        fetch('/api/auth/users', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/auth/url/discord', { credentials: 'include', cache: 'no-store' }),
      ]);
      const users = await usersRes.json().catch(() => null);
      if (users?.discordConfig) applyConfig(users.discordConfig as RuntimeDiscordConfig);
      const oauth = await urlRes.json().catch(() => null);
      if (oauth) {
        setOauthConfigured(Boolean(oauth.configured));
        setRedirectUri(String(oauth.redirectUri || ''));
      }
    } catch {
      // backend restarting — leave the form as it was
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => {
    if (isSuperAdmin) void load();
  }, [isSuperAdmin, load]);

  if (!isSuperAdmin) return null;

  const guildOk = isSnowflake(guildId);
  const roleOk = isSnowflake(roleId);
  const inviteOk = /^https?:\/\/\S+$/i.test(inviteUrl.trim());
  const dirty =
    !saved ||
    saved.guildId !== guildId.trim() ||
    saved.guildName !== guildName.trim() ||
    saved.advancedPanelRoleId !== roleId.trim() ||
    saved.inviteUrl !== inviteUrl.trim();
  const canSave = guildOk && roleOk && inviteOk && dirty && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch('/api/auth/discord/config', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId: guildId.trim(),
          guildName: guildName.trim() || undefined,
          inviteUrl: inviteUrl.trim(),
          advancedPanelRoleId: roleId.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        onShowToast(
          'Could not save Discord settings',
          String(data?.error || `Backend refused the change (HTTP ${res.status})`),
          'error',
          'error',
        );
        return;
      }
      applyConfig(data.discordConfig as RuntimeDiscordConfig);
      setReport(null);
      onShowToast(
        'Discord settings saved',
        'The gate now checks this guild and role. Reconnect Discord if a user already linked.',
        'success',
        'save',
      );
    } catch {
      onShowToast('Could not save Discord settings', 'The backend is unreachable.', 'error', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runDiagnostics = async () => {
    setTesting(true);
    setReport(null);
    try {
      const res = await fetch('/api/auth/discord/diagnostics', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        onShowToast(
          'Connection test failed',
          String(data?.error || `Backend refused the test (HTTP ${res.status})`),
          'error',
          'error',
        );
        return;
      }
      setReport(data as DiagnosticReport);
    } catch {
      onShowToast('Connection test failed', 'The backend is unreachable.', 'error', 'error');
    } finally {
      setTesting(false);
    }
  };

  const reportTone = (result: DiagnosticResult | undefined) =>
    result === 'ok'
      ? 'bg-secondary/10 border-secondary/35 text-secondary'
      : result === 'unavailable' || result === 'not_configured'
        ? 'bg-error/10 border-error/35 text-error'
        : 'bg-amber-400/10 border-amber-400/35 text-amber-200';

  return (
    <div className="p-5 rounded-xl bg-surface-container-low border border-white/[0.08] space-y-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-title-md text-title-md text-white font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">tune</span>
            Discord Access Settings
          </h3>
          <p className="text-[11px] text-outline mt-1">
            Guild and verified role the Advanced Panel checks. Super Admin only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-outline hover:text-white cursor-pointer disabled:opacity-50 shrink-0"
        >
          {open ? 'Hide' : 'Configure'}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span
          className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
            roleOk
              ? 'bg-secondary/15 text-secondary border-secondary/35'
              : 'bg-amber-400/15 text-amber-300 border-amber-400/35'
          }`}
        >
          {roleOk ? 'Role configured' : 'No role set'}
        </span>
        <span
          className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase border ${
            oauthConfigured
              ? 'bg-secondary/15 text-secondary border-secondary/35'
              : 'bg-error/15 text-error border-error/35'
          }`}
        >
          {oauthConfigured === null
            ? 'OAuth unknown'
            : oauthConfigured
              ? 'OAuth client ready'
              : 'OAuth client missing'}
        </span>
      </div>

      {open && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="kp-label block mb-1">Guild ID</span>
              <input
                value={guildId}
                onChange={(e) => setGuildId(e.target.value)}
                placeholder="18–19 digit server id"
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="kp-label block mb-1">Verified role ID</span>
              <input
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                placeholder="role that unlocks the Advanced Panel"
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="kp-label block mb-1">Guild name</span>
              <input
                value={guildName}
                onChange={(e) => setGuildName(e.target.value)}
                placeholder="Shown in the verification dialog"
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="kp-label block mb-1">Invite link</span>
              <input
                value={inviteUrl}
                onChange={(e) => setInviteUrl(e.target.value)}
                placeholder="https://discord.gg/..."
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
              />
            </label>
          </div>

          {(!guildOk || !roleOk || !inviteOk) && (
            <p className="text-[11px] text-amber-300">
              {!guildOk
                ? 'Guild ID must be the 18–19 digit server id. '
                : ''}
              {!roleOk ? 'Role ID must be the 18–19 digit role id. ' : ''}
              {!inviteOk ? 'Invite link must start with https://.' : ''}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-mono text-outline truncate">
              Redirect URI to register: <span className="text-white">{redirectUri || '—'}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => saved && applyConfig(saved)}
                disabled={!dirty || saving}
                className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-outline hover:text-white cursor-pointer disabled:opacity-40"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                className="px-4 py-1.5 rounded-lg bg-primary hover:opacity-95 text-on-primary-container text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[15px]">save</span>
                {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runDiagnostics()}
              disabled={dirty || testing || !guildOk || !roleOk}
              title={
                dirty
                  ? 'Save your changes first — the test checks the saved configuration.'
                  : 'Read your own Discord membership and roles for this guild'
              }
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-semibold text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-[15px]">network_check</span>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <span className="text-[10px] text-outline">
              {dirty
                ? 'Save first — the test checks what is stored.'
                : 'Checks your own Discord account, so grant yourself the role before testing.'}
            </span>
          </div>

          {report && (
            <div className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${reportTone(report.result)}`}>
              <div className="flex items-center gap-1.5 text-[11px] font-bold">
                <span className="material-symbols-outlined text-[15px]">
                  {report.result === 'ok'
                    ? 'check_circle'
                    : report.result === 'unavailable' || report.result === 'not_configured'
                      ? 'error'
                      : 'warning'}
                </span>
                {report.result === 'ok'
                  ? 'Guild and role confirmed'
                  : report.result === 'role_missing'
                    ? 'Role not on your account'
                    : report.result === 'not_a_member'
                      ? 'Not a member of that guild'
                      : report.result === 'reconnect_required'
                        ? 'Discord authorization needed'
                        : report.result === 'not_configured'
                          ? 'Configuration incomplete'
                          : 'Discord unavailable'}
              </div>
              <p className="text-[11px] leading-relaxed opacity-95">{report.message}</p>
              {report.result === 'role_missing' && report.roles && report.roles.length > 0 && (
                <p className="text-[10px] font-mono leading-relaxed opacity-80 break-all">
                  Your role ids: {report.roles.join(', ')}
                </p>
              )}
            </div>
          )}

          <p className="text-[10px] text-outline leading-relaxed">
            Saved to the panel's local config and applied on the next backend start. A role change
            only affects accounts whose Discord grant is still valid; everyone else is asked to
            reconnect.
          </p>
        </div>
      )}
    </div>
  );
};

export default DiscordAccessSettings;

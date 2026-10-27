import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthUser } from '../types';
import { PanelAccessPayload } from '../hooks/usePanelAccess';

interface DiscordBotGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser;
  currentServerCount: number;
  attemptedServerName?: string;
  /** Entitlement read from GET /api/account/access — never local state. */
  access: PanelAccessPayload | null;
  accessLoading?: boolean;
  accessError?: string | null;
  onRefreshAccess: () => Promise<PanelAccessPayload | null>;
  onUserUpdated: (updatedUser: AuthUser) => void;
  onEnforceTwoServerReset?: () => void;
  onVerificationSuccessProceed?: () => void;
  onAdvancedUnlocked?: () => void;
  purpose?: 'limit' | 'advanced';
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

interface BotLog {
  time: string;
  author: string;
  text: string;
  type: 'bot' | 'user' | 'warn';
}

const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const POLL_INTERVAL_MS = 4000;
const POLL_ATTEMPTS = 30;

export const DiscordBotGateModal: React.FC<DiscordBotGateModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  currentServerCount,
  attemptedServerName,
  access,
  accessLoading = false,
  accessError = null,
  onRefreshAccess,
  onUserUpdated,
  onEnforceTwoServerReset,
  onVerificationSuccessProceed,
  onAdvancedUnlocked,
  purpose = 'limit',
  onShowToast,
}) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isLeavingGuild, setIsLeavingGuild] = useState(false);
  const [awaitingOAuth, setAwaitingOAuth] = useState(false);
  const pollRef = useRef<number | null>(null);
  const [botLogs, setBotLogs] = useState<BotLog[]>([]);

  const discord = access?.discord;
  const advanced = access?.panels.advanced;
  const isLinked = Boolean(discord?.linked);
  const inGuild = Boolean(discord?.guildMember);
  const rolePresent = Boolean(discord?.requiredRolePresent);
  const isVerified = inGuild && rolePresent;
  const advancedAllowed = advanced?.allowed === true;
  const maxLimit = access?.user.maxServerLimit ?? currentUser.maxServerLimit ?? 2;
  const guildName = discord?.guildName || currentUser.discordGuildName || 'the Discord server';
  // Configured by a Super Admin (Panel Control → Discord Access Settings); no
  // invite is baked into the app.
  const inviteUrl = discord?.inviteUrl || currentUser.discordInviteUrl || '';
  const oauthConfigured = discord?.oauthConfigured !== false;

  const appendLog = useCallback(
    (author: string, text: string, type: BotLog['type'] = 'bot') => {
      setBotLogs((prev) => [...prev.slice(-40), { time: clock(), author, text, type }]);
    },
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setAwaitingOAuth(false);
  }, []);

  // Reset the transcript whenever the dialog opens, and never leave a poll
  // running after it closes.
  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      return;
    }
    setBotLogs([
      {
        time: clock(),
        author: 'Panel access control',
        text: 'Entitlement is evaluated by the local server. The Advanced Panel unlocks only for a linked Discord account holding the verification role, read with that account’s own Discord authorization.',
        type: 'bot',
      },
    ]);
    if (accessError) appendLog('Panel access control', accessError, 'warn');
  }, [isOpen, stopPolling, accessError, appendLog]);

  useEffect(() => {
    if (isLinked) stopPolling();
  }, [isLinked, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const finishSuccess = (next: PanelAccessPayload) => {
    if (purpose === 'advanced' && next.panels.advanced.allowed) {
      onShowToast(
        'Advanced Panel Unlocked',
        'Verified Discord membership is on file for this account.',
        'success',
        'lock_open',
      );
      onVerificationSuccessProceed?.();
      onAdvancedUnlocked?.();
      return;
    }
    if (next.discord.guildMember && next.discord.requiredRolePresent) {
      onShowToast(
        `Discord Verified — ${next.user.maxServerLimit} Servers`,
        `@${next.discord.username || currentUser.username} is verified in ${guildName}.`,
        'success',
        'verified',
      );
      onVerificationSuccessProceed?.();
    }
  };

  const startPolling = () => {
    stopPolling();
    setAwaitingOAuth(true);
    let attempts = 0;
    pollRef.current = window.setInterval(() => {
      attempts += 1;
      if (attempts > POLL_ATTEMPTS) {
        stopPolling();
        appendLog('Panel access control', 'Stopped watching for the Discord link (two minutes).', 'warn');
        return;
      }
      void onRefreshAccess().then((next) => {
        if (!next) return;
        if (next.discord.linked) {
          stopPolling();
          appendLog(
            'Panel access control',
            `Discord account linked: @${next.discord.username || 'unknown'}.`,
            'user',
          );
          if (next.discord.guildMember && next.discord.requiredRolePresent) {
            finishSuccess(next);
          } else if (next.discord.guildMember) {
            appendLog('Panel access control', 'Member found, verification role missing.', 'warn');
          } else {
            appendLog('Panel access control', 'Linked, but not in the official server yet.', 'warn');
          }
        }
      });
    }, POLL_INTERVAL_MS);
  };

  const handleConnectDiscord = async (reconnect = false) => {
    if (!oauthConfigured) {
      onShowToast(
        'Discord OAuth Not Configured',
        'Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on the panel backend to enable account linking.',
        'error',
        'key_off',
      );
      return;
    }
    setIsConnecting(true);
    appendLog('Panel access control', 'Requesting a Discord authorization URL…');
    try {
      const res = await fetch('/api/account/discord/link/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reconnect }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        appendLog('Panel access control', data?.error || 'Could not start Discord linking.', 'warn');
        onShowToast(
          'Could Not Connect Discord',
          data?.error || 'The panel could not start the Discord link.',
          'error',
          'error',
        );
        return;
      }
      if (data.alreadyLinked) {
        appendLog('Panel access control', 'Discord is already linked to this account.', 'user');
        await handleCheckVerification();
        return;
      }
      try {
        window.open(String(data.url), '_blank', 'noopener,noreferrer');
      } catch {
        // Popup blocked; the URL is still shown in the dialog.
      }
      appendLog('Panel access control', 'Opened Discord in your browser. Waiting for the callback…', 'user');
      onShowToast(
        'Discord Authorization Opened',
        'Approve the request in Discord, then this dialog updates automatically.',
        'info',
        'open_in_new',
      );
      startPolling();
    } catch {
      onShowToast(
        'Could Not Reach the Panel Server',
        'Discord linking needs the local backend to be running.',
        'error',
        'error',
      );
    } finally {
      setIsConnecting(false);
    }
  };

  async function handleCheckVerification() {
    setIsChecking(true);
    appendLog('Panel access control', 'Querying Discord for guild membership and the verification role…');
    try {
      const next = await onRefreshAccess();
      if (!next) {
        onShowToast(
          'Could Not Check Verification',
          accessError || 'The backend did not return an access decision.',
          'warning',
          'sync_problem',
        );
        return;
      }
      // Mirror the backend's decision into the profile the shell renders (badge
      // and server limit). This never grants anything: `next` came from Express.
      const verifiedNow = next.discord.guildMember && next.discord.requiredRolePresent;
      onUserUpdated({
        ...currentUser,
        discordVerified: verifiedNow,
        discordMemberStatus: verifiedNow
          ? 'verified_in_guild'
          : next.discord.linked
            ? currentUser.discordMemberStatus
            : 'not_connected',
        discordUsername: next.discord.username || currentUser.discordUsername,
        discordUserId: next.discord.discordUserId || currentUser.discordUserId,
        maxServerLimit: next.user.maxServerLimit,
      });
      if (next.panels.advanced.allowed) {
        appendLog('Panel access control', 'Verified: role present. Advanced Panel unlocked.', 'bot');
        finishSuccess(next);
        return;
      }
      appendLog('Panel access control', next.panels.advanced.message, 'warn');
      onShowToast('Verification Not Complete', next.panels.advanced.message, 'warning', 'lock');
    } finally {
      setIsChecking(false);
    }
  }

  const handleLeaveDiscordServer = async () => {
    setIsLeavingGuild(true);
    try {
      const res = await fetch('/api/auth/discord/leave-guild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.user) {
        onUserUpdated(data.user);
        onEnforceTwoServerReset?.();
        // Re-read the entitlement so the Advanced Panel locks immediately
        // instead of waiting for the five-minute cache to expire.
        await onRefreshAccess();
        appendLog('Panel access control', 'Guild verification cleared for this account.', 'warn');
        onShowToast(
          'Verification Removed',
          'Advanced Panel access and the extra server limit were revoked for this account.',
          'warning',
          'link_off',
        );
      } else {
        onShowToast(
          'Could Not Clear Verification',
          data?.error || 'The backend rejected the request.',
          'error',
          'error',
        );
      }
    } catch {
      onShowToast(
        'Could Not Reach the Panel Server',
        'Check the local backend and try again.',
        'error',
        'error',
      );
    } finally {
      setIsLeavingGuild(false);
    }
  };

  if (!isOpen) return null;

  const reason = advanced?.reason;
  const reconnectRequired = reason === 'discord_reconnect_required' || discord?.reconnectRequired === true;
  const lockedByPolicy =
    reason === 'required_role_not_configured' || reason === 'verification_unavailable';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-xl bg-[#0e131f] border border-[#5865F2]/40 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-[#5865F2]/25 via-[#5865F2]/10 to-surface border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#5865F2] flex items-center justify-center shadow-[#5865F2]/30 shrink-0">
              <svg className="w-6 h-6 text-white fill-current" viewBox="0 0 24 24">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">
                  {purpose === 'advanced'
                    ? 'Unlock the Advanced Panel'
                    : 'Discord Server Verification'}
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    advancedAllowed
                      ? 'bg-secondary/20 text-secondary border border-secondary/40'
                      : isVerified
                        ? 'bg-secondary/15 text-secondary border border-secondary/30'
                        : 'bg-amber-400/20 text-amber-300 border border-amber-400/40'
                  }`}
                >
                  {advancedAllowed
                    ? 'Advanced Unlocked'
                    : isVerified
                      ? `Verified • ${maxLimit} Servers Max`
                      : 'Simple Panel Only'}
                </span>
              </div>
              <p className="text-xs text-outline font-mono mt-0.5">
                Operator: <span className="text-white">@{currentUser.username}</span> • Active
                Servers:{' '}
                <span className="text-primary font-bold">
                  {currentServerCount} / {maxLimit}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-outline hover:text-white cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {purpose === 'limit' && !isVerified && currentServerCount >= 2 && (
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-400/35 flex items-start gap-3">
              <span className="material-symbols-outlined text-amber-400 text-[22px] shrink-0 mt-0.5">
                lock_clock
              </span>
              <div className="text-xs space-y-1">
                <div className="font-bold text-white">
                  2-Server Limit Reached ({currentServerCount} / 2 active)
                  {attemptedServerName ? ` — Cannot create “${attemptedServerName}” yet` : ''}
                </div>
                <p className="text-outline leading-relaxed">
                  Verify your Discord account to raise the limit to{' '}
                  <strong className="text-white">{maxLimit} servers</strong>.
                </p>
              </div>
            </div>
          )}

          {advanced && !advancedAllowed && (
            <div
              className={`p-3.5 rounded-xl border flex items-start gap-3 ${
                lockedByPolicy
                  ? 'bg-error/10 border-error/35'
                  : 'bg-[#5865F2]/10 border-[#5865F2]/35'
              }`}
            >
              <span
                className={`material-symbols-outlined text-[22px] shrink-0 mt-0.5 ${
                  lockedByPolicy ? 'text-error' : 'text-[#8ea1e1]'
                }`}
              >
                {lockedByPolicy ? 'gpp_maybe' : 'lock'}
              </span>
              <div className="text-xs space-y-1">
                <div className="font-bold text-white">
                  {reason === 'discord_not_linked'
                    ? 'Step 1 — Connect your Discord account'
                    : reason === 'not_a_guild_member'
                      ? `Step 2 — Join ${guildName}`
                      : reason === 'required_role_missing'
                        ? 'Step 3 — Get the verified role in Discord'
                        : reason === 'discord_reconnect_required'
                          ? 'Reconnect Discord to continue'
                          : reason === 'required_role_not_configured'
                            ? 'The panel owner has not configured a verification role'
                            : reason === 'verification_unavailable'
                              ? 'Discord could not be reached'
                              : 'Advanced Panel locked'}
                </div>
                <p className="text-outline leading-relaxed">{advanced.message}</p>
                {reason === 'verification_unavailable' && (
                  <p className="text-outline/80 leading-relaxed">
                    Your account was not granted access while the check was unknown. Try again once
                    Discord responds.
                  </p>
                )}
              </div>
            </div>
          )}

          {accessError && (
            <div className="p-3 rounded-xl bg-error/10 border border-error/30 text-[11px] text-error">
              {accessError}
            </div>
          )}

          {/* Step list with real states */}
          <div className="rounded-xl bg-surface-lowest border border-white/[0.08] divide-y divide-white/[0.06]">
            <StatusRow
              index="1"
              label="Discord account linked"
              state={isLinked ? 'done' : 'todo'}
              detail={
                isLinked
                  ? reconnectRequired
                    ? 'Authorization expired — reconnect to re-check roles'
                    : discord?.username
                      ? `@${discord.username}`
                      : 'Linked'
                  : oauthConfigured
                    ? 'Not connected yet'
                    : 'OAuth is not configured on this panel'
              }
            />
            <StatusRow
              index="2"
              label={`Member of ${guildName}`}
              state={inGuild ? 'done' : isLinked ? 'todo' : 'idle'}
              detail={
                inGuild
                  ? 'Membership confirmed by Discord'
                  : reconnectRequired
                    ? 'Reconnect first — roles are read with your own authorization'
                    : 'Join the official server'
              }
            />
            <StatusRow
              index="3"
              label="Verification role present"
              state={rolePresent ? 'done' : inGuild ? 'todo' : 'idle'}
              detail={
                !discord?.requiredRoleConfigured
                  ? 'No role id configured'
                  : rolePresent
                    ? 'Role confirmed by Discord'
                    : 'Get the role in the Discord server, then check again'
              }
            />
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-r from-[#5865F2]/20 via-[#5865F2]/10 to-surface-lowest border border-[#5865F2]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center text-white font-bold shrink-0">
                <span className="material-symbols-outlined text-[20px]">forum</span>
              </div>
              <div>
                <span className="text-sm font-bold text-white">{guildName}</span>
                <p className="text-[11px] text-outline mt-0.5">
                  Join with the same Discord account you link here.
                </p>
                <div className="text-[11px] font-mono text-[#8ea1e1] mt-1 break-all">
                  {inviteUrl || 'No invite link configured yet — ask the panel owner.'}
                </div>
              </div>
            </div>
            {inviteUrl ? (
              <a
                href={inviteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                Join Discord Server
              </a>
            ) : (
              <span className="text-[11px] text-outline shrink-0">Invite not configured</span>
            )}
          </div>

          <div className="rounded-xl bg-[#080b11] border border-white/[0.08] p-3 font-mono text-[11px] space-y-1.5 max-h-36 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-wider text-outline flex items-center justify-between border-b border-white/[0.06] pb-1">
              <span>Access control log</span>
              <span className="text-secondary flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
                {accessLoading || awaitingOAuth ? 'CHECKING…' : 'IDLE'}
              </span>
            </div>
            {botLogs.map((log, i) => (
              <div key={i} className="leading-relaxed">
                <span className="text-white/40">[{log.time}]</span>{' '}
                <span
                  className={
                    log.type === 'warn'
                      ? 'text-error font-bold'
                      : log.type === 'user'
                        ? 'text-primary font-bold'
                        : 'text-[#8ea1e1] font-bold'
                  }
                >
                  {log.author}:
                </span>{' '}
                <span
                  className={
                    log.type === 'warn'
                      ? 'text-amber-300'
                      : log.type === 'bot'
                        ? 'text-white/90'
                        : 'text-secondary'
                  }
                >
                  {log.text}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {isLinked ? (
              <button
                type="button"
                disabled={isLeavingGuild}
                onClick={() => void handleLeaveDiscordServer()}
                className="px-3.5 py-2 rounded-xl bg-error/15 hover:bg-error/25 disabled:opacity-50 border border-error/40 text-error text-xs font-bold font-mono flex items-center gap-1.5 cursor-pointer transition-all"
              >
                <span className="material-symbols-outlined text-[16px]">logout</span>
                {isLeavingGuild ? 'Clearing verification…' : 'Clear verification for this account'}
              </button>
            ) : (
              <div className="text-[11px] font-mono text-outline">
                The Advanced Panel stays locked until a backend check succeeds.
              </div>
            )}

            <div className="flex items-center gap-2.5 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-outline hover:text-white cursor-pointer"
              >
                Close
              </button>

              {!isLinked || reconnectRequired ? (
                <button
                  type="button"
                  disabled={isConnecting || !oauthConfigured}
                  onClick={() => void handleConnectDiscord(reconnectRequired)}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#5865F2] to-indigo-500 hover:opacity-95 disabled:opacity-50 text-white text-xs font-bold shadow-[#5865F2]/25 flex items-center gap-2 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[17px]">link</span>
                  {isConnecting
                    ? 'Starting Discord…'
                    : reconnectRequired
                      ? 'Reconnect Discord Account'
                      : 'Connect Discord Account'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isChecking || accessLoading}
                  onClick={() => void handleCheckVerification()}
                  className="px-5 py-2.5 rounded-xl bg-secondary hover:opacity-95 disabled:opacity-50 text-on-secondary-container text-xs font-bold shadow flex items-center gap-2 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[17px]">verified</span>
                  {isChecking || accessLoading ? 'Checking Discord…' : 'Check Verification'}
                </button>
              )}
            </div>
          </div>

          {awaitingOAuth && (
            <p className="text-[11px] text-outline font-mono">
              Waiting for Discord authorization… finish the browser step;
              <button
                type="button"
                onClick={() => {
                  stopPolling();
                  void handleCheckVerification();
                }}
                className="ml-1 text-primary hover:underline cursor-pointer"
              >
                check now
              </button>
              . Access is only granted after the server verifies the role.
            </p>
          )}

          {!oauthConfigured && !isLinked && (
            <p className="text-[11px] text-amber-300/90 font-mono">
              Backend: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to enable linking.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

const StatusRow: React.FC<{
  index: string;
  label: string;
  detail: string;
  state: 'done' | 'todo' | 'idle';
}> = ({ index, label, detail, state }) => (
  <div className="px-4 py-3 flex items-center gap-3">
    <div
      className={`size-7 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${
        state === 'done'
          ? 'bg-secondary/20 text-secondary'
          : state === 'todo'
            ? 'bg-amber-400/15 text-amber-300'
            : 'bg-white/5 text-outline'
      }`}
    >
      {state === 'done' ? (
        <span className="material-symbols-outlined text-[16px]">check</span>
      ) : (
        index
      )}
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-xs font-bold text-white">{label}</p>
      <p className="text-[11px] text-outline truncate">{detail}</p>
    </div>
  </div>
);

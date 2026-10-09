import React, { useState } from 'react';
import { AuthUser } from '../types';

interface DiscordBotGateModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser;
  currentServerCount: number;
  attemptedServerName?: string;
  onUserUpdated: (updatedUser: AuthUser) => void;
  onEnforceTwoServerReset?: () => void;
  onVerificationSuccessProceed?: () => void;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

export const DiscordBotGateModal: React.FC<DiscordBotGateModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  currentServerCount,
  attemptedServerName,
  onUserUpdated,
  onEnforceTwoServerReset,
  onVerificationSuccessProceed,
  onShowToast,
}) => {
  const [discordHandle, setDiscordHandle] = useState(
    currentUser.discordUsername || `${currentUser.username}#0001`
  );
  const [discordUserId, setDiscordUserId] = useState(
    currentUser.discordUserId || '849201938472019283'
  );
  const [guildInviteUrl, setGuildInviteUrl] = useState(
    currentUser.discordInviteUrl || 'https://discord.gg/iskingpanel'
  );
  const [verificationCode] = useState(
    () => `KING-${Math.floor(1000 + Math.random() * 9000)}`
  );
  const [hasJoinedGuildStep, setHasJoinedGuildStep] = useState<boolean>(
    Boolean(currentUser.discordVerified)
  );
  const [showJoinDiscordPopup, setShowJoinDiscordPopup] = useState<boolean>(false);
  const [isVerifyingBot, setIsVerifyingBot] = useState(false);
  const [isLeavingGuild, setIsLeavingGuild] = useState(false);
  const [botTerminalLogs, setBotTerminalLogs] = useState<
    Array<{ time: string; author: string; text: string; type: 'bot' | 'user' | 'warn' }>
  >([
    {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      author: 'ISKingBot#4821 [BOT]',
      text: `Watching #bot-verify in "${currentUser.discordGuildName || 'IS King Official Discord Server'}". Standard users are limited to 1 or 2 servers. Join our Discord & run /verify to unlock up to 10 servers.`,
      type: 'bot',
    },
  ]);

  if (!isOpen) return null;

  const isVerified = Boolean(currentUser.discordVerified);
  const maxLimit = isVerified ? currentUser.maxServerLimit || 10 : 2;

  const appendBotLog = (
    author: string,
    text: string,
    type: 'bot' | 'user' | 'warn' = 'bot'
  ) => {
    setBotTerminalLogs((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        author,
        text,
        type,
      },
    ]);
  };

  const handleJoinDiscordServer = () => {
    setHasJoinedGuildStep(true);
    appendBotLog(
      discordHandle || `${currentUser.username}#0001`,
      `Joined Discord Server via ${guildInviteUrl} (GUILD_MEMBER_ADD event received)`,
      'user'
    );
    appendBotLog(
      'ISKingBot#4821 [BOT]',
      `Welcome @${discordHandle || currentUser.username}! You are now in the Discord server. Click "Confirm & Verify with Bot" to unlock >2 servers.`,
      'bot'
    );
    onShowToast(
      'Joined Official Discord Server',
      `Connected to ${currentUser.discordGuildName || 'IS King Official Discord Server'}. Now complete Bot Verification!`,
      'info',
      'forum'
    );
  };

  const handleCopyInviteLink = () => {
    try {
      navigator.clipboard.writeText(guildInviteUrl);
    } catch {
      // ignore clipboard errors
    }
    onShowToast(
      'Discord Invite Link Copied',
      `Copied ${guildInviteUrl} to clipboard.`,
      'info',
      'content_copy'
    );
  };

  const handleVerifyWithDiscordBot = async () => {
    if (!discordHandle.trim()) {
      onShowToast(
        'Discord Username Required',
        'Please enter your Discord handle (e.g. Mio_Sakura#0001) to verify with the bot.',
        'warning',
        'person'
      );
      return;
    }

    setIsVerifyingBot(true);
    setHasJoinedGuildStep(true);
    appendBotLog(
      discordHandle.trim(),
      `/verify account:${currentUser.username} code:${verificationCode}`,
      'user'
    );

    try {
      const res = await fetch('/api/auth/discord/verify-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser.username,
          discordUsername: discordHandle.trim(),
          discordUserId: discordUserId.trim(),
          verificationCode,
          guildInviteUrl: guildInviteUrl.trim(),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        appendBotLog(
          'ISKingBot#4821 [BOT]',
          `Verification failed: ${data.error || 'User not found in Discord server.'}`,
          'warn'
        );
        onShowToast(
          'Discord Bot Verification Failed',
          data.error || 'Make sure you joined the Discord server first.',
          'error',
          'error'
        );
        setIsVerifyingBot(false);
        return;
      }

      appendBotLog(
        'ISKingBot#4821 [BOT]',
        `VERIFIED! Linked Discord @${discordHandle.trim()} <-> Panel @${currentUser.username}. Server creation limit upgraded from 2 -> ${data.user.maxServerLimit} servers!`,
        'bot'
      );

      setShowJoinDiscordPopup(false);
      onUserUpdated(data.user);
      onShowToast(
        'Discord Bot Verified! Limit Unlocked (10 Servers)',
        `Verified @${discordHandle.trim()} in Discord Server. You can now create more than 2 servers!`,
        'success',
        'verified'
      );

      if (onVerificationSuccessProceed) {
        setTimeout(() => {
          onVerificationSuccessProceed();
        }, 650);
      }
    } catch {
      onShowToast(
        'Verification Network Error',
        'Could not reach local Discord Bot verification daemon.',
        'error',
        'error'
      );
    } finally {
      setIsVerifyingBot(false);
    }
  };

  const handleLeaveDiscordServer = async () => {
    setIsLeavingGuild(true);
    appendBotLog(
      discordHandle || currentUser.discordUsername || currentUser.username,
      `Left Discord Server (GUILD_MEMBER_REMOVE webhook fired)`,
      'warn'
    );

    try {
      const res = await fetch('/api/auth/discord/leave-guild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: currentUser.username,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setHasJoinedGuildStep(false);
        setShowJoinDiscordPopup(false);
        appendBotLog(
          'ISKingBot#4821 [BOT]',
          `ALERT: @${currentUser.username} left the Discord server! Revoked bot verification & reset server creation limit back to 2 servers.`,
          'warn'
        );
        onUserUpdated(data.user);
        if (onEnforceTwoServerReset) {
          onEnforceTwoServerReset();
        }
        onShowToast(
          'Left Discord Server — Limit Reset to 2',
          'Discord Bot detected you left the server. Your server creation limit has been reset to 2 servers.',
          'warning',
          'link_off'
        );
      }
    } catch {
      onShowToast(
        'Error Updating Guild Status',
        'Could not process guild leave event.',
        'error',
        'error'
      );
    } finally {
      setIsLeavingGuild(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl bg-[#0e131f] border border-[#5865F2]/40 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Discord Sovereign Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-[#5865F2]/25 via-[#5865F2]/10 to-surface border-b border-white/10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-[#5865F2] flex items-center justify-center shadow-lg shadow-[#5865F2]/30 shrink-0">
              <svg className="w-6 h-6 text-white fill-current" viewBox="0 0 24 24">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061.0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">
                  Discord Server &amp; Bot Verification Popup
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                    isVerified
                      ? 'bg-secondary/20 text-secondary border border-secondary/40'
                      : currentUser.discordMemberStatus === 'left_guild'
                      ? 'bg-error/20 text-error border border-error/40'
                      : 'bg-amber-400/20 text-amber-300 border border-amber-400/40'
                  }`}
                >
                  {isVerified
                    ? `Bot Verified • ${maxLimit} Servers Max`
                    : currentUser.discordMemberStatus === 'left_guild'
                    ? 'Left Discord • Reset to 2 Servers'
                    : 'Standard Login • 2 Servers Max'}
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
          {/* Reason Banner if triggered by trying to create >2 servers */}
          {!isVerified && currentServerCount >= 2 && (
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-400/35 flex items-start gap-3">
              <span className="material-symbols-outlined text-amber-400 text-[22px] shrink-0 mt-0.5">
                lock_clock
              </span>
              <div className="text-xs space-y-1">
                <div className="font-bold text-white">
                  2-Server Creation Limit Reached ({currentServerCount} / 2 Servers Active)
                  {attemptedServerName ? ` — Cannot Create "${attemptedServerName}" Yet` : ''}
                </div>
                <p className="text-outline leading-relaxed">
                  All logged-in users can set up <strong className="text-white">1 or 2 servers only</strong> by default. To set up more than 2 servers, join our{' '}
                  <strong className="text-[#8ea1e1]">Discord Server</strong> and get verified by our{' '}
                  <strong className="text-secondary">Discord Bot</strong>. If you leave the Discord server, your server creation limit automatically resets back to 2.
                </p>
              </div>
            </div>
          )}

          {/* Alert Banner if User Left Discord Server */}
          {currentUser.discordMemberStatus === 'left_guild' && !isVerified && (
            <div className="p-3.5 rounded-xl bg-error/15 border border-error/40 flex items-start gap-3">
              <span className="material-symbols-outlined text-error text-[20px] shrink-0 mt-0.5">
                gpp_bad
              </span>
              <div className="text-xs">
                <div className="font-bold text-white">
                  Discord Server Exit Detected — Limit Reset to 2 Servers
                </div>
                <p className="text-outline mt-0.5">
                  Our Discord Bot detected that you left the Discord server. Your server creation quota has been reset to <strong className="text-white">2 servers</strong>. Rejoin the Discord server and run <code className="text-primary">/verify</code> below to restore multi-server access.
                </p>
              </div>
            </div>
          )}

          {/* Prominent Join Discord Server Invite Card */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-[#5865F2]/20 via-[#5865F2]/10 to-surface-lowest border border-[#5865F2]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center text-white font-bold shrink-0 shadow-md">
                <span className="material-symbols-outlined text-[20px]">forum</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">
                    {currentUser.discordGuildName || 'IS King Official Discord Server'}
                  </span>
                  <span className="text-[10px] font-mono text-secondary">
                    ● 1,420 Online
                  </span>
                </div>
                <p className="text-[11px] text-outline mt-0.5">
                  Join our Discord server first so <code className="text-white">ISKingBot#4821</code> can verify your account and unlock up to 10 servers.
                </p>
                <div className="text-[11px] font-mono text-[#8ea1e1] mt-1">
                  Invite: {guildInviteUrl}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopyInviteLink}
                className="px-2.5 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/15 text-xs font-mono text-white cursor-pointer flex items-center gap-1"
                title="Copy Discord Invite Link"
              >
                <span className="material-symbols-outlined text-[15px]">content_copy</span>
                Copy
              </button>
              <a
                href={guildInviteUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleJoinDiscordServer}
                className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all ${
                  hasJoinedGuildStep || isVerified
                    ? 'bg-secondary/20 text-secondary border border-secondary/40'
                    : 'bg-[#5865F2] hover:bg-[#4752C4] text-white shadow-lg shadow-[#5865F2]/30'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">
                  {hasJoinedGuildStep || isVerified ? 'check_circle' : 'open_in_new'}
                </span>
                {hasJoinedGuildStep || isVerified ? 'Joined Discord Server' : 'Join Discord Server'}
              </a>
            </div>
          </div>

          {/* Step 1 & Step 2 Form */}
          <div className="p-4 rounded-xl bg-surface-lowest border border-white/10 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                  1. Official Discord Server Invite Link
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={guildInviteUrl}
                    onChange={(e) => setGuildInviteUrl(e.target.value)}
                    className="flex-1 bg-surface border border-white/15 focus:border-[#5865F2] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleJoinDiscordServer}
                    className={`px-3 py-2 rounded-lg text-xs font-bold font-mono shrink-0 flex items-center gap-1.5 cursor-pointer transition-all ${
                      hasJoinedGuildStep || isVerified
                        ? 'bg-secondary/20 text-secondary border border-secondary/40'
                        : 'bg-[#5865F2] hover:bg-[#4752C4] text-white shadow'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[15px]">
                      {hasJoinedGuildStep || isVerified ? 'check_circle' : 'group_add'}
                    </span>
                    {hasJoinedGuildStep || isVerified ? 'Joined' : 'Join Discord'}
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                  2. Your Discord Username / Tag
                </label>
                <input
                  type="text"
                  value={discordHandle}
                  onChange={(e) => setDiscordHandle(e.target.value)}
                  placeholder="e.g. Mio_Sakura#0001"
                  className="w-full bg-surface border border-white/15 focus:border-[#5865F2] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                  Discord User Snowflake ID (For Bot Check)
                </label>
                <input
                  type="text"
                  value={discordUserId}
                  onChange={(e) => setDiscordUserId(e.target.value)}
                  placeholder="18-digit Discord ID"
                  className="w-full bg-surface border border-white/15 focus:border-[#5865F2] rounded-lg px-3 py-1.5 text-xs font-mono text-white/90 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                  Discord Bot Command Token (<code className="text-primary">#bot-verify</code>)
                </label>
                <div className="w-full bg-black/50 border border-primary/30 rounded-lg px-3 py-1.5 text-xs font-mono text-primary flex items-center justify-between">
                  <span>/verify code:{verificationCode}</span>
                  <span className="text-[10px] text-secondary">Bot Ready</span>
                </div>
              </div>
            </div>

            {/* Live Discord Bot Verification Console */}
            <div className="rounded-xl bg-[#080b11] border border-white/10 p-3 font-mono text-[11px] space-y-1.5 max-h-36 overflow-y-auto">
              <div className="text-[10px] uppercase tracking-wider text-outline flex items-center justify-between border-b border-white/5 pb-1">
                <span>Discord Bot Live Gateway — ISKingBot#4821</span>
                <span className="text-secondary flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-ping" />
                  GUILD_MEMBER_WATCHER ACTIVE
                </span>
              </div>
              {botTerminalLogs.map((log, i) => (
                <div key={i} className="leading-relaxed">
                  <span className="text-white/40">[{log.time}]</span>{' '}
                  <span
                    className={
                      log.type === 'bot'
                        ? 'text-[#8ea1e1] font-bold'
                        : log.type === 'warn'
                        ? 'text-error font-bold'
                        : 'text-primary font-bold'
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
          </div>

          {/* Action Footer: Verify Discord Bot Button (Opens Join Discord Option Popup or Verifies) */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {isVerified ? (
              <button
                type="button"
                disabled={isLeavingGuild}
                onClick={handleLeaveDiscordServer}
                className="px-3.5 py-2 rounded-xl bg-error/15 hover:bg-error/25 border border-error/40 text-error text-xs font-bold font-mono flex items-center gap-1.5 cursor-pointer transition-all"
              >
                <span className="material-symbols-outlined text-[16px]">logout</span>
                {isLeavingGuild
                  ? 'Leaving Discord Server...'
                  : 'Leave Discord Server (Resets Limit to 2)'}
              </button>
            ) : (
              <div className="text-[11px] font-mono text-outline">
                Leaving the Discord server automatically resets your limit back to{' '}
                <strong className="text-white">2 servers</strong>.
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

              {/* Clicking Verify Discord Bot Button opens the Join Discord Option Popup */}
              <button
                type="button"
                disabled={isVerifyingBot}
                onClick={() => setShowJoinDiscordPopup(true)}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#5865F2] to-indigo-500 hover:opacity-95 text-white text-xs font-bold shadow-lg shadow-[#5865F2]/25 flex items-center gap-2 cursor-pointer transition-all"
              >
                <span className="material-symbols-outlined text-[17px]">verified</span>
                {isVerifyingBot
                  ? 'Verifying with Discord Bot...'
                  : isVerified
                  ? 'Verify Discord Bot (10 Servers Active)'
                  : 'Verify Discord Bot (Join Discord & Unlock >2)'}
              </button>
            </div>
          </div>
        </div>

        {/* Dedicated Popup inside Verify Discord Bot Button giving option to Join Discord */}
        {showJoinDiscordPopup && (
          <div
            className="absolute inset-0 z-30 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-150"
            onClick={() => setShowJoinDiscordPopup(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl bg-[#13192a] border border-[#5865F2]/60 shadow-2xl p-5 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#5865F2] flex items-center justify-center text-white shadow-lg shadow-[#5865F2]/30 shrink-0">
                    <span className="material-symbols-outlined text-[22px]">forum</span>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      Join Discord &amp; Verify Discord Bot
                    </h3>
                    <p className="text-[11px] text-outline">
                      Connect to our Discord server to unlock more than 2 servers
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowJoinDiscordPopup(false)}
                  className="p-1 rounded-lg bg-white/5 hover:bg-white/10 text-outline hover:text-white cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>

              <div className="p-3.5 rounded-xl bg-surface-lowest border border-white/10 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-outline">Official Discord Server:</span>
                  <span className="font-bold text-white">
                    {currentUser.discordGuildName || 'IS King Official Discord'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-outline">Invite URL:</span>
                  <span className="font-mono text-[#8ea1e1]">{guildInviteUrl}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-outline">Discord Handle:</span>
                  <span className="font-mono text-primary">{discordHandle}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-outline">Status:</span>
                  <span
                    className={`font-mono font-bold ${
                      hasJoinedGuildStep || isVerified ? 'text-secondary' : 'text-amber-300'
                    }`}
                  >
                    {hasJoinedGuildStep || isVerified
                      ? 'Joined Discord Server'
                      : 'Step 1: Join Discord First'}
                  </span>
                </div>
              </div>

              <div className="space-y-2.5">
                {/* Option 1: Join Discord Server */}
                <a
                  href={guildInviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleJoinDiscordServer}
                  className="w-full py-2.5 px-4 rounded-xl bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-[#5865F2]/30 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[17px]">group_add</span>
                  {hasJoinedGuildStep || isVerified
                    ? 'Open Discord Server Again (Joined)'
                    : '1. Join Discord Server Now'}
                </a>

                {/* Option 2: Verify with Discord Bot */}
                <button
                  type="button"
                  disabled={isVerifyingBot}
                  onClick={handleVerifyWithDiscordBot}
                  className="w-full py-2.5 px-4 rounded-xl bg-secondary hover:opacity-95 text-on-secondary-container text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-secondary/20 cursor-pointer transition-all"
                >
                  <span className="material-symbols-outlined text-[17px]">verified</span>
                  {isVerifyingBot
                    ? 'Verifying with Discord Bot...'
                    : '2. Confirm & Verify with Discord Bot (Unlock 10 Servers)'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowJoinDiscordPopup(false)}
                  className="w-full py-2 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-outline hover:text-white text-xs font-semibold cursor-pointer transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

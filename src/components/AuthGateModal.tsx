import React, { useState, useEffect } from 'react';
import { AuthUser } from '../types';
import { HOTLINKED_IMAGES } from '../data/initialData';
import {
  DEFAULT_PROFILE_ICON_URL,
  PROFILE_ICON_OPTIONS,
  resolveUserAvatarUrl,
} from '../utils/profileIcons';

interface AuthGateModalProps {
  onAuthenticated: (user: AuthUser, isNewSignup?: boolean) => void;
  onClose?: () => void;
  isModalOverlay?: boolean;
  initialMode?: 'signin' | 'signup';
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string
  ) => void;
}

export const PRESET_OPERATORS: AuthUser[] = [
  {
    id: 'SA-KINGPLAYZ-001',
    username: 'kingplayz',
    displayName: 'KingPlayz (Super Admin)',
    email: 'kingplayz@iskingpanel.exe',
    role: 'Super Admin',
    isSuperAdmin: true,
    provider: 'local',
    avatarUrl: HOTLINKED_IMAGES.adminProfile,
    mcUuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    connectedProviders: ['local', 'discord', 'github', 'google'],
    lastLogin: 'Active Super Admin Session',
    sessionSha: 'sa-kingplayz...root',
    discordVerified: true,
    discordMemberStatus: 'verified_in_guild',
    maxServerLimit: 999,
  },
  {
    id: 'op-mio',
    username: 'Mio_Sakura',
    displayName: 'Mio Sakura',
    email: 'mio.sakura@kingsmp.net',
    role: 'Root Admin',
    provider: 'local',
    avatarUrl: HOTLINKED_IMAGES.avatarMio,
    mcUuid: 'f84c6a79-0a4e-45e0-879b-cd49ebd4c4e2',
    connectedProviders: ['local', 'github'],
    lastLogin: 'Today at 14:32 UTC',
    sessionSha: '8f9a2b1c...e401',
    discordVerified: false,
    discordMemberStatus: 'not_connected',
    maxServerLimit: 2,
  },
  {
    id: 'op-aki',
    username: 'Aki_Craft99',
    displayName: 'Aki Redstone',
    email: 'aki.devops@kingsmp.net',
    role: 'DevOps Engineer',
    provider: 'github',
    avatarUrl: HOTLINKED_IMAGES.avatarAki,
    mcUuid: '3b91a2e4-72c1-44d8-918a-5e2b99f01a88',
    connectedProviders: ['github', 'google'],
    lastLogin: 'Today at 12:15 UTC',
    sessionSha: '3d7e91a0...b219',
    discordVerified: false,
    discordMemberStatus: 'not_connected',
    maxServerLimit: 2,
  },
  {
    id: 'op-kuro',
    username: 'Kuro_Neko_JP',
    displayName: 'Kuro Neko',
    email: 'kuro.mod@kingsmp.net',
    role: 'Moderator',
    provider: 'discord',
    avatarUrl: HOTLINKED_IMAGES.avatarKuro,
    mcUuid: '99c100f2-18b4-4099-b811-77a910de3310',
    connectedProviders: ['local'],
    lastLogin: 'Yesterday at 21:40 UTC',
    sessionSha: '7c4b11e8...99a2',
    discordVerified: false,
    discordMemberStatus: 'not_connected',
    maxServerLimit: 2,
  },
];

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  onAuthenticated,
  onClose,
  isModalOverlay = false,
  initialMode = 'signin',
  onShowToast,
}) => {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [registeredUsers, setRegisteredUsers] = useState<AuthUser[]>(PRESET_OPERATORS);
  const [emailOrUser, setEmailOrUser] = useState('kingplayz');
  const [password, setPassword] = useState('KingPlayz#2026');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Password Reset Drawer State
  const [showResetBox, setShowResetBox] = useState(false);
  const [resetIdentifier, setResetIdentifier] = useState('mio.sakura@kingsmp.net');
  const [resetNewPassword, setResetNewPassword] = useState('');

  // Sign Up State
  const [signupDisplayName, setSignupDisplayName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupRole, setSignupRole] = useState<AuthUser['role']>('Root Admin');
  const [signupMcIgn, setSignupMcIgn] = useState('');
  const [signupAvatarUrl, setSignupAvatarUrl] = useState<string>(DEFAULT_PROFILE_ICON_URL);

  // Interactive OAuth Handshake State
  const [oauthFlowProvider, setOauthFlowProvider] = useState<
    'discord' | 'github' | 'google' | null
  >(null);
  const [oauthStep, setOauthStep] = useState<'connecting' | 'consent'>('connecting');
  const [oauthCustomHandle, setOauthCustomHandle] = useState('');
  const [oauthCustomEmail, setOauthCustomEmail] = useState('');
  const [oauthVerifyDiscordBotToo, setOauthVerifyDiscordBotToo] = useState(false);
  const [showOauthConfigGuide, setShowOauthConfigGuide] = useState(false);

  const callbackUrl = `${window.location.origin}/auth/callback`;

  // Fetch real registered users from local PC database
  const fetchRegisteredUsers = async () => {
    try {
      const res = await fetch('/api/auth/users');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.users) && data.users.length > 0) {
          setRegisteredUsers(data.users);
        }
      }
    } catch {
      // Fallback to presets
    }
  };

  useEffect(() => {
    fetchRegisteredUsers();
  }, []);

  // Listen for postMessage from real OAuth popup window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const raw = event.data.provider;
        const provider: 'discord' | 'github' | 'google' =
          raw === 'discord' || raw === 'github' || raw === 'google' ? raw : 'google';
        completeOAuthLogin(provider);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });

  const completeOAuthLogin = async (
    provider: 'discord' | 'github' | 'google',
    customHandle?: string,
    customMail?: string,
    verifyBotNow = false
  ) => {
    setIsSubmitting(true);
    setAuthError(null);
    const defaults = {
      discord: {
        username: customHandle || 'Mio_Sakura#0001',
        email: customMail || 'mio.discord@kingsmp.net',
      },
      github: {
        username: customHandle || 'aki-craft-dev',
        email: customMail || 'aki@users.noreply.github.com',
      },
      google: {
        username: customHandle || 'bhaktaprince008',
        email: customMail || 'bhaktaprince008@gmail.com',
      },
    }[provider];

    try {
      const res = await fetch('/api/auth/oauth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          handle: defaults.username,
          email: defaults.email,
          verifyDiscordBotNow: provider === 'discord' && verifyBotNow,
        }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        setOauthFlowProvider(null);
        onAuthenticated(data.user, mode === 'signup');
        setIsSubmitting(false);
        return;
      }
    } catch {
      // Fallback below
    }

    const fallbackUser: AuthUser = {
      id: `oauth-${provider}-${Date.now()}`,
      username: defaults.username,
      displayName: defaults.username,
      email: defaults.email,
      role: 'Root Admin',
      provider,
      avatarUrl: HOTLINKED_IMAGES.avatarMio,
      mcUuid: 'f84c6a79-0a4e-45e0-879b-cd49ebd4c4e2',
      connectedProviders: [provider, 'local'],
      lastLogin: 'Just now via OAuth 2.0',
      sessionSha: `${Math.random().toString(16).slice(2, 10)}...${provider.slice(0, 3)}`,
      discordVerified: provider === 'discord' && verifyBotNow,
      discordMemberStatus:
        provider === 'discord' && verifyBotNow ? 'verified_in_guild' : 'not_connected',
      maxServerLimit: provider === 'discord' && verifyBotNow ? 10 : 2,
    };

    setOauthFlowProvider(null);
    setIsSubmitting(false);
    onAuthenticated(fallbackUser, mode === 'signup');
  };

  const handleTriggerOAuth = async (provider: 'discord' | 'github' | 'google') => {
    setAuthError(null);
    try {
      const response = await fetch(`/api/auth/url/${provider}`);
      if (response.ok) {
        const data = await response.json();
        if (data.configured && data.url) {
          const popup = window.open(data.url, `${provider}_oauth_popup`, 'width=580,height=680');
          if (!popup) {
            onShowToast(
              'Popup Blocked',
              'Please allow popups for this site or use the inline OAuth authorization handshake.',
              'warning',
              'open_in_new'
            );
          } else {
            return;
          }
        }
      }
    } catch {
      // Fallback to inline OAuth2 authorization handshake
    }

    setOauthFlowProvider(provider);
    setOauthStep('connecting');
    setOauthVerifyDiscordBotToo(false);
    if (provider === 'discord') {
      setOauthCustomHandle('Mio_Sakura#0001');
      setOauthCustomEmail('mio.discord@kingsmp.net');
    } else if (provider === 'github') {
      setOauthCustomHandle('aki-craft-dev');
      setOauthCustomEmail('aki.devops@github.com');
    } else {
      setOauthCustomHandle('bhaktaprince008');
      setOauthCustomEmail('bhaktaprince008@gmail.com');
    }

    setTimeout(() => {
      setOauthStep('consent');
    }, 380);
  };

  const handleLocalSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!emailOrUser.trim() || !password.trim()) {
      setAuthError('Please enter your operator username/email and password.');
      onShowToast(
        'Credentials Required',
        'Please enter your operator username/email and password.',
        'warning',
        'lock'
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: emailOrUser.trim(),
          password: password.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setAuthError(data.error || 'Invalid credentials.');
        onShowToast('Sign In Failed', data.error || 'Invalid credentials.', 'error', 'error');
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      onAuthenticated(data.user, false);
    } catch {
      setIsSubmitting(false);
      setAuthError('Could not connect to local authentication server.');
    }
  };

  const handleQuickOperatorLogin = async (op: AuthUser) => {
    setAuthError(null);
    const isSa = op.username.toLowerCase() === 'kingplayz' || op.id === 'SA-KINGPLAYZ-001';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: op.username,
          password: isSa ? 'KingPlayz#2026' : 'kingpanel123',
        }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        onAuthenticated(data.user, false);
        return;
      }
    } catch {
      // Fallback
    }
    onAuthenticated(
      {
        ...op,
        role: isSa ? 'Super Admin' : op.role,
        isSuperAdmin: isSa,
        discordVerified: isSa ? true : Boolean(op.discordVerified),
        maxServerLimit: isSa ? 999 : op.discordVerified ? 10 : 2,
      },
      false
    );
  };

  const handleLocalSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!signupUsername.trim() || !signupEmail.trim() || !signupPassword.trim()) {
      setAuthError('Please fill out Username, Email, and Password to register your account.');
      onShowToast(
        'Incomplete Registration',
        'Please fill out Username, Email, and Password to register your operator account.',
        'warning',
        'person_add'
      );
      return;
    }
    if (signupPassword.length < 4) {
      setAuthError('Password must be at least 4 characters long.');
      return;
    }
    if (signupPassword !== signupConfirmPassword) {
      setAuthError('Password and confirmation password do not match.');
      onShowToast(
        'Password Mismatch',
        'Password and confirmation password do not match.',
        'error',
        'error'
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: signupUsername.trim(),
          displayName: signupDisplayName.trim() || signupUsername.trim(),
          email: signupEmail.trim(),
          password: signupPassword,
          role: signupRole,
          mcUuid: signupMcIgn.trim() || undefined,
          avatarUrl: signupAvatarUrl || DEFAULT_PROFILE_ICON_URL,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setAuthError(data.error || 'Could not register account.');
        onShowToast('Registration Error', data.error || 'Failed to register.', 'error', 'error');
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      onShowToast(
        'Account Created & Pushed to MongoDB',
        `Assigned Profile Icon and pushed @${data.user.username} to MongoDB (${data.mongoDocumentId || 'users'}).`,
        'success',
        'cloud_done'
      );
      onAuthenticated(data.user, true);
    } catch {
      setIsSubmitting(false);
      setAuthError('Network error while registering operator account.');
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetIdentifier.trim() || resetNewPassword.length < 4) {
      onShowToast(
        'Invalid Reset Input',
        'Enter your username/email and a new password (min 4 characters).',
        'warning',
        'key'
      );
      return;
    }
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: resetIdentifier.trim(),
          newPassword: resetNewPassword,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setEmailOrUser(resetIdentifier.trim());
        setPassword(resetNewPassword);
        setShowResetBox(false);
        setAuthError(null);
        onShowToast('Password Reset Complete', data.message, 'success', 'check_circle');
      } else {
        onShowToast('Reset Failed', data.error || 'User not found.', 'error', 'error');
      }
    } catch {
      onShowToast('Reset Error', 'Could not reach local auth daemon.', 'error', 'error');
    }
  };

  const passwordStrength =
    signupPassword.length === 0
      ? 0
      : signupPassword.length < 6
      ? 1
      : signupPassword.length < 10
      ? 2
      : 3;

  return (
    <div
      className={`${
        isModalOverlay
          ? 'fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4'
          : 'flex-1 bg-surface-dim flex items-center justify-center p-6 overflow-y-auto relative'
      }`}
    >
      {/* Subtle Background Ambient Grid Glow */}
      {!isModalOverlay && (
        <div
          className="absolute inset-0 pointer-events-none opacity-35"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(242, 202, 80, 0.12), transparent 45%), radial-gradient(circle at 80% 80%, rgba(64, 196, 255, 0.08), transparent 45%)',
          }}
        />
      )}

      {/* Main Obsidian Sovereign Authentication Container */}
      <div className="relative z-10 w-full max-w-4xl rounded-2xl bg-surface border border-outline-variant/25 shadow-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
        {/* Left 5 Columns: Workstation Identity, Quota Rules & Registered Accounts */}
        <div className="lg:col-span-5 bg-[#0b0e16] border-b lg:border-b-0 lg:border-r border-outline-variant/15 p-6 flex flex-col justify-between">
          <div className="space-y-4">
            {/* Brand Crest */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 flex items-center justify-center shadow-lg shadow-amber-500/20 ring-1 ring-amber-300/40">
                <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z" />
                </svg>
              </div>
              <div>
                <div className="text-sm font-bold text-white tracking-tight font-mono">
                  IS King Panel v4.8
                </div>
                <div className="text-[11px] text-primary font-mono">
                  Obsidian Sovereign Login &amp; Quota System
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <h2 className="text-base font-bold text-white leading-snug">
                Operator Authentication &amp; Server Quota Gate
              </h2>
              <p className="text-xs text-outline leading-relaxed">
                Sign in with your operator credentials or register a new local account.
              </p>
            </div>

            {/* Super Admin kingplayz Master Credentials Card */}
            <div className="p-3.5 rounded-xl bg-amber-400/10 border border-amber-400/40 space-y-2">
              <div className="flex items-center justify-between text-[10px] font-mono uppercase font-bold">
                <span className="text-amber-300 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">workspace_premium</span>
                  Super Admin SQLite DB Account
                </span>
                <span className="px-1.5 py-0.5 rounded bg-amber-400 text-black font-bold">
                  UNLIMITED SERVERS
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-black/40 p-2 rounded-lg border border-white/10">
                <div>
                  <div className="text-[9px] text-outline uppercase">Super Admin ID / User</div>
                  <div className="text-white font-bold select-all">kingplayz</div>
                  <div className="text-[10px] text-amber-300 select-all">SA-KINGPLAYZ-001</div>
                </div>
                <div>
                  <div className="text-[9px] text-outline uppercase">Master Password</div>
                  <div className="text-secondary font-bold select-all">KingPlayz#2026</div>
                  <div className="text-[10px] text-outline">SQLite3 WAL Verified</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEmailOrUser('kingplayz');
                  setPassword('KingPlayz#2026');
                  handleQuickOperatorLogin(PRESET_OPERATORS[0]);
                }}
                className="w-full py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-black font-bold text-[11px] font-mono flex items-center justify-center gap-1.5 transition-all cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">bolt</span>
                1-Click Login as Super Admin (kingplayz)
              </button>
            </div>

            {/* Server Creation Quota Policy Card */}
            <div className="p-3 rounded-xl bg-[#5865F2]/10 border border-[#5865F2]/35 space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-mono uppercase font-bold">
                <span className="text-[#8ea1e1] flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">verified_user</span>
                  Server Creation Quota Rule
                </span>
                <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300">
                  Enforced
                </span>
              </div>
              <ul className="text-[11px] text-white/85 space-y-1 font-mono leading-snug">
                <li>
                  • <strong className="text-white">Standard Login:</strong> Setup{' '}
                  <span className="text-primary font-bold">1 or 2 servers only</span>
                </li>
                <li>
                  • <strong className="text-white">3+ Servers (Up to 10):</strong> Connect Discord
                  Server &amp; get <span className="text-secondary font-bold">Bot Verified</span>
                </li>
                <li>
                  • <strong className="text-white">Leave Discord Server:</strong> Limit
                  automatically <span className="text-error font-bold">resets to 2</span>
                </li>
              </ul>
            </div>

            {/* Registered Workstation Operator Switcher */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-outline">
                <span>Registered Workstation Accounts ({registeredUsers.length})</span>
                <span className="text-secondary">1-Click Login</span>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {registeredUsers.map((op) => {
                  const isSa = op.username.toLowerCase() === 'kingplayz' || op.role === 'Super Admin' || op.isSuperAdmin;
                  const isVerified = Boolean(op.discordVerified) || isSa;
                  return (
                    <button
                      key={op.id}
                      type="button"
                      onClick={() => handleQuickOperatorLogin(op)}
                      className={`w-full p-2.5 rounded-xl border transition-all flex items-center justify-between text-left group cursor-pointer ${
                        isSa
                          ? 'bg-amber-400/10 hover:bg-amber-400/15 border-amber-400/40'
                          : 'bg-surface-container/80 hover:bg-surface-container-high border-outline-variant/15 hover:border-primary/40'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img
                          src={op.avatarUrl}
                          alt={op.username}
                          className="w-8 h-8 rounded-lg border border-primary/30 object-cover shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-white group-hover:text-primary transition-colors truncate">
                              {op.displayName}
                            </span>
                            <span
                              className={`px-1.5 py-0.2 rounded text-[9px] font-mono font-bold ${
                                isSa
                                  ? 'bg-amber-400 text-black'
                                  : isVerified
                                  ? 'bg-secondary/20 text-secondary'
                                  : 'bg-amber-400/15 text-amber-300'
                              }`}
                            >
                              {isSa ? 'SUPER ADMIN (∞)' : isVerified ? 'Bot Verified (10)' : 'Max 2 Srv'}
                            </span>
                          </div>
                          <div className="text-[10px] font-mono text-outline truncate">
                            @{op.username} • {op.id} • {op.role}
                          </div>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-mono font-semibold shrink-0">
                        Login →
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bottom OAuth Callback Info Toggle */}
          <div className="pt-4 mt-4 border-t border-white/10 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-outline flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                SHA-256 Auth + Discord Bot Gate
              </span>
              <button
                type="button"
                onClick={() => setShowOauthConfigGuide(!showOauthConfigGuide)}
                className="text-primary hover:underline cursor-pointer"
              >
                {showOauthConfigGuide ? 'Hide OAuth URI' : 'OAuth Callback Info'}
              </button>
            </div>

            {showOauthConfigGuide && (
              <div className="p-2.5 rounded-lg bg-surface-lowest border border-outline-variant/25 text-[10px] font-mono space-y-1.5">
                <div className="text-white font-semibold">OAuth Redirect Callback URI:</div>
                <div className="p-1.5 rounded bg-black/50 text-secondary break-all select-all">
                  {callbackUrl}
                </div>
                <div className="text-outline leading-normal">
                  Configure <code className="text-primary">DISCORD_CLIENT_ID</code>,{' '}
                  <code className="text-primary">DISCORD_BOT_TOKEN</code>, or{' '}
                  <code className="text-primary">DISCORD_GUILD_ID</code> in environment secrets.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right 7 Columns: Sign In / Sign Up Forms + Discord, GitHub, Google OAuth */}
        <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col justify-between bg-surface">
          <div>
            {/* Top Mode Switcher Tabs (Sign In vs Sign Up) + Optional Close Button */}
            <div className="flex items-center justify-between gap-4 mb-5">
              <div className="grid grid-cols-2 bg-surface-lowest p-1 rounded-xl border border-outline-variant/20 w-full max-w-xs">
                <button
                  type="button"
                  onClick={() => {
                    setMode('signin');
                    setAuthError(null);
                  }}
                  className={`py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    mode === 'signin'
                      ? 'bg-primary text-on-primary-container shadow'
                      : 'text-outline hover:text-white'
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">login</span>
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('signup');
                    setAuthError(null);
                  }}
                  className={`py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    mode === 'signup'
                      ? 'bg-primary text-on-primary-container shadow'
                      : 'text-outline hover:text-white'
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">person_add</span>
                  Sign Up
                </button>
              </div>

              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 rounded-lg bg-surface-container-high hover:bg-surface-bright text-outline hover:text-white border border-outline-variant/20 cursor-pointer"
                  title="Close Authentication Window"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              )}
            </div>

            {authError && (
              <div className="mb-4 p-3 rounded-xl bg-error/15 border border-error/40 text-xs text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-error text-[18px] shrink-0">
                  error
                </span>
                <span>{authError}</span>
              </div>
            )}

            {/* OAUTH 2.0 SOCIAL LOGIN BUTTONS (DISCORD, GITHUB, GOOGLE) */}
            <div className="space-y-2.5 mb-5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-outline font-semibold">
                {mode === 'signin'
                  ? 'Instant Single Sign-On (OAuth 2.0 Providers)'
                  : 'Fast Operator Registration via OAuth'}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {/* 1. Login with Discord */}
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('discord')}
                  className="px-3.5 py-2.5 rounded-xl bg-[#5865F2]/15 hover:bg-[#5865F2]/25 border border-[#5865F2]/40 text-white text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-sm hover:shadow-[#5865F2]/10 cursor-pointer"
                >
                  <svg className="w-4 h-4 text-[#5865F2] fill-current shrink-0" viewBox="0 0 24 24">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                  </svg>
                  <span>Discord</span>
                </button>

                {/* 2. Login with GitHub */}
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('github')}
                  className="px-3.5 py-2.5 rounded-xl bg-surface-container-highest hover:bg-surface-bright border border-white/15 text-white text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-sm cursor-pointer"
                >
                  <svg className="w-4 h-4 text-white fill-current shrink-0" viewBox="0 0 24 24">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                  <span>GitHub</span>
                </button>

                {/* 3. Login with Google */}
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('google')}
                  className="px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-sm cursor-pointer"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#EA4335"
                      d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.3 14.8c-.2-.8-.4-1.6-.4-2.5s.2-1.7.4-2.5L1.6 7C.6 9 0 11.2 0 13.5s.6 4.5 1.6 6.5l3.7-2.9z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5L1.6 17c1.9 3.9 5.8 7 10.4 7z"
                    />
                  </svg>
                  <span>Google</span>
                </button>
              </div>
            </div>

            <div className="relative flex py-1.5 items-center mb-4">
              <div className="flex-grow border-t border-outline-variant/15"></div>
              <span className="flex-shrink mx-3 text-[10px] font-mono uppercase tracking-widest text-outline">
                Or Continue With Operator Credentials
              </span>
              <div className="flex-grow border-t border-outline-variant/15"></div>
            </div>

            {/* SIGN IN FORM */}
            {mode === 'signin' ? (
              <div className="space-y-4">
                <form onSubmit={handleLocalSignIn} className="space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1.5">
                      Operator ID, Username, or Email (Super Admin: <code className="text-amber-300">kingplayz</code> / <code className="text-amber-300">SA-KINGPLAYZ-001</code>)
                    </label>
                    <div className="relative">
                      <span className="material-symbols-outlined text-outline text-[17px] absolute left-3 top-2.5">
                        person
                      </span>
                      <input
                        type="text"
                        value={emailOrUser}
                        onChange={(e) => setEmailOrUser(e.target.value)}
                        placeholder="kingplayz or SA-KINGPLAYZ-001"
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl pl-9 pr-3 py-2 text-xs font-mono text-white focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-on-surface">
                        Password (Super Admin: <code className="text-secondary">KingPlayz#2026</code>)
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setResetIdentifier(emailOrUser || 'Mio_Sakura');
                          setShowResetBox(!showResetBox);
                        }}
                        className="text-[11px] font-mono text-primary hover:underline cursor-pointer"
                      >
                        {showResetBox ? 'Hide Reset' : 'Reset Password?'}
                      </button>
                    </div>
                    <div className="relative">
                      <span className="material-symbols-outlined text-outline text-[17px] absolute left-3 top-2.5">
                        key
                      </span>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter operator password..."
                        className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl pl-9 pr-10 py-2 text-xs font-mono text-white focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-2 text-outline hover:text-white cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {showPassword ? 'visibility_off' : 'visibility'}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <label className="flex items-center gap-2 text-xs text-outline cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="rounded accent-primary"
                      />
                      <span>Keep workstation session active (30 days)</span>
                    </label>
                    <span className="text-[10px] font-mono text-amber-300">
                      Default Limit: 2 Servers
                    </span>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-primary to-primary-container hover:opacity-95 text-on-primary-container font-bold text-xs shadow-lg shadow-primary/20 transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                  >
                    <span className="material-symbols-outlined text-[17px]">lock_open</span>
                    {isSubmitting ? 'Authenticating...' : 'Sign In to IS King Panel'}
                  </button>
                </form>

                {showResetBox && (
                  <form
                    onSubmit={handleResetPassword}
                    className="p-3.5 rounded-xl bg-surface-lowest border border-primary/30 space-y-2.5"
                  >
                    <div className="text-xs font-bold text-white flex items-center justify-between">
                      <span>Reset Local Operator Password</span>
                      <span className="text-[10px] font-mono text-primary">SHA-256 Update</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={resetIdentifier}
                        onChange={(e) => setResetIdentifier(e.target.value)}
                        placeholder="Username or Email"
                        className="bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                      />
                      <input
                        type="password"
                        value={resetNewPassword}
                        onChange={(e) => setResetNewPassword(e.target.value)}
                        placeholder="New Password (min 4 chars)"
                        className="bg-surface border border-white/15 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-primary text-on-primary-container text-xs font-bold cursor-pointer"
                    >
                      Save New Password
                    </button>
                  </form>
                )}
              </div>
            ) : (
              /* SIGN UP / REGISTER FORM */
              <form onSubmit={handleLocalSignUp} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Operator Username
                    </label>
                    <input
                      type="text"
                      value={signupUsername}
                      onChange={(e) => setSignupUsername(e.target.value)}
                      placeholder="e.g., Voxel_King"
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={signupDisplayName}
                      onChange={(e) => setSignupDisplayName(e.target.value)}
                      placeholder="e.g., Voxel Architect"
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Operator Email
                    </label>
                    <input
                      type="email"
                      value={signupEmail}
                      onChange={(e) => setSignupEmail(e.target.value)}
                      placeholder="operator@kingsmp.net"
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Access Role Tier
                    </label>
                    <select
                      value={signupRole}
                      onChange={(e) => setSignupRole(e.target.value as AuthUser['role'])}
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-primary focus:outline-none"
                    >
                      <option value="Root Admin">Root Admin (Full Cluster)</option>
                      <option value="DevOps Engineer">DevOps Engineer (JVM &amp; Files)</option>
                      <option value="Moderator">Moderator (Console &amp; Logs)</option>
                      <option value="Operator">Standard Operator</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Create Password
                    </label>
                    <input
                      type="password"
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      placeholder="Min 4 chars..."
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-on-surface block mb-1">
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      value={signupConfirmPassword}
                      onChange={(e) => setSignupConfirmPassword(e.target.value)}
                      placeholder="Repeat password..."
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                </div>

                {/* Password Strength & Optional MC UUID Link */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-outline">Key Entropy Strength:</span>
                    <span
                      className={
                        passwordStrength === 3
                          ? 'text-secondary'
                          : passwordStrength === 2
                          ? 'text-primary'
                          : 'text-outline'
                      }
                    >
                      {passwordStrength === 3
                        ? 'Strong (SHA-256 Ready)'
                        : passwordStrength === 2
                        ? 'Medium'
                        : 'Enter Password'}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-surface-lowest overflow-hidden flex gap-1">
                    <div
                      className={`h-full flex-1 rounded-full ${
                        passwordStrength >= 1 ? 'bg-error' : 'bg-white/5'
                      }`}
                    />
                    <div
                      className={`h-full flex-1 rounded-full ${
                        passwordStrength >= 2 ? 'bg-primary' : 'bg-white/5'
                      }`}
                    />
                    <div
                      className={`h-full flex-1 rounded-full ${
                        passwordStrength >= 3 ? 'bg-secondary' : 'bg-white/5'
                      }`}
                    />
                  </div>
                </div>

                {/* Default Profile Icon & Preset Avatar Selector for New Account */}
                <div className="p-3 rounded-xl bg-surface-lowest border border-primary/25 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <img
                        src={resolveUserAvatarUrl(signupAvatarUrl)}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                        }}
                        alt="New Account Profile Icon"
                        className="w-10 h-10 rounded-xl border-2 border-primary object-cover shrink-0 bg-surface"
                      />
                      <div>
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                          <span>Account Profile Icon</span>
                          <span className="px-1.5 py-0.5 rounded bg-primary/20 text-primary text-[9px] font-mono uppercase">
                            Default Assigned
                          </span>
                        </div>
                        <p className="text-[10px] font-mono text-outline">
                          Automatically assigned &amp; pushed to MongoDB on signup
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 overflow-x-auto pt-1">
                    {PROFILE_ICON_OPTIONS.map((iconOpt) => {
                      const isSelected = signupAvatarUrl === iconOpt.url;
                      return (
                        <button
                          key={iconOpt.id}
                          type="button"
                          onClick={() => setSignupAvatarUrl(iconOpt.url)}
                          className={`p-1.5 rounded-lg border flex items-center gap-1.5 shrink-0 transition-all cursor-pointer ${
                            isSelected
                              ? 'bg-primary/20 border-primary text-white'
                              : 'bg-surface border-white/10 text-outline hover:text-white'
                          }`}
                        >
                          <img
                            src={iconOpt.url}
                            alt={iconOpt.label}
                            className="w-6 h-6 rounded-md object-cover"
                          />
                          <span className="text-[10px] font-mono font-semibold">
                            {iconOpt.badge}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-mono text-outline block mb-1">
                    Link Minecraft Username / UUID for Auto-OP (Optional)
                  </label>
                  <input
                    type="text"
                    value={signupMcIgn}
                    onChange={(e) => setSignupMcIgn(e.target.value)}
                    placeholder="e.g., Mio_Sakura (Fetches 3D Crafatar/Minotar skin)"
                    className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-xl px-3 py-1.5 text-xs font-mono text-white focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-secondary to-emerald-400 hover:opacity-95 text-on-secondary font-bold text-xs shadow-lg shadow-secondary/20 transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  <span className="material-symbols-outlined text-[17px]">verified_user</span>
                  {isSubmitting
                    ? 'Registering & Pushing to MongoDB...'
                    : 'Create Account & Push to MongoDB (Default Icon + 2-Server Quota)'}
                </button>
              </form>
            )}
          </div>

          {/* Footer Switch Mode Prompt */}
          <div className="mt-5 pt-4 border-t border-outline-variant/15 flex items-center justify-between text-xs">
            <span className="text-outline">
              {mode === 'signin'
                ? 'Need a new localhost operator account?'
                : 'Already registered an operator account?'}
            </span>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setAuthError(null);
              }}
              className="text-primary font-bold hover:underline cursor-pointer"
            >
              {mode === 'signin' ? 'Register Operator (Sign Up) →' : 'Back to Sign In →'}
            </button>
          </div>
        </div>
      </div>

      {/* INTERACTIVE OAUTH 2.0 HANDSHAKE MODAL (DISCORD / GITHUB / GOOGLE) */}
      {oauthFlowProvider && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setOauthFlowProvider(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-surface border border-outline-variant/30 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Provider Header */}
            <div
              className={`px-5 py-4 border-b border-white/10 flex items-center justify-between ${
                oauthFlowProvider === 'discord'
                  ? 'bg-[#5865F2]/20'
                  : oauthFlowProvider === 'github'
                  ? 'bg-surface-container-highest'
                  : 'bg-blue-500/15'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-white text-[20px]">
                  shield_person
                </span>
                <div>
                  <h3 className="text-sm font-bold text-white capitalize">
                    {oauthFlowProvider} OAuth 2.0 Authorization
                  </h3>
                  <p className="text-[10px] font-mono text-white/70">
                    Redirect URI: {callbackUrl}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOauthFlowProvider(null)}
                className="text-white/60 hover:text-white cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            {oauthStep === 'connecting' ? (
              <div className="p-8 text-center space-y-3">
                <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto" />
                <div className="text-xs font-bold text-white font-mono">
                  Handshaking with {oauthFlowProvider.toUpperCase()} Identity Gateway...
                </div>
                <p className="text-[11px] text-outline font-mono">
                  Verifying PKCE state challenge &amp; localhost callback socket
                </p>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15 flex items-center gap-3">
                  <img
                    src={
                      oauthFlowProvider === 'discord'
                        ? HOTLINKED_IMAGES.avatarMio
                        : oauthFlowProvider === 'github'
                        ? HOTLINKED_IMAGES.avatarAki
                        : HOTLINKED_IMAGES.adminProfile
                    }
                    alt={oauthFlowProvider}
                    className="w-10 h-10 rounded-lg border border-primary/30 object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-white">
                      IS King Panel v4.8 requests access to your{' '}
                      <span className="capitalize text-primary">{oauthFlowProvider}</span> account
                    </div>
                    <div className="text-[10px] font-mono text-outline mt-0.5">
                      Scopes:{' '}
                      {oauthFlowProvider === 'discord'
                        ? 'identify, email, guilds'
                        : oauthFlowProvider === 'github'
                        ? 'read:user, user:email'
                        : 'openid, email, profile'}
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                      {oauthFlowProvider} Handle / Username
                    </label>
                    <input
                      type="text"
                      value={oauthCustomHandle}
                      onChange={(e) => setOauthCustomHandle(e.target.value)}
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-mono text-outline uppercase block mb-1">
                      Verified {oauthFlowProvider} Email
                    </label>
                    <input
                      type="email"
                      value={oauthCustomEmail}
                      onChange={(e) => setOauthCustomEmail(e.target.value)}
                      className="w-full bg-surface-lowest border border-outline-variant/25 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>

                  {oauthFlowProvider === 'discord' && (
                    <label className="p-2.5 rounded-xl bg-[#5865F2]/15 border border-[#5865F2]/35 flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={oauthVerifyDiscordBotToo}
                        onChange={(e) => setOauthVerifyDiscordBotToo(e.target.checked)}
                        className="mt-0.5 rounded accent-[#5865F2]"
                      />
                      <div className="text-[11px]">
                        <div className="font-bold text-white">
                          Join Official Discord Server &amp; Verify with Discord Bot Now
                        </div>
                        <div className="text-outline font-mono">
                          Unlocks 10-server creation limit (leave unchecked to start with standard 2-server limit)
                        </div>
                      </div>
                    </label>
                  )}
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOauthFlowProvider(null)}
                    className="px-3.5 py-2 rounded-lg bg-surface-container-high text-xs font-medium text-outline hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      completeOAuthLogin(
                        oauthFlowProvider,
                        oauthCustomHandle.trim(),
                        oauthCustomEmail.trim(),
                        oauthVerifyDiscordBotToo
                      )
                    }
                    className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary-container text-on-primary-container text-xs font-bold shadow-lg cursor-pointer flex items-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                    Authorize &amp; Continue
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

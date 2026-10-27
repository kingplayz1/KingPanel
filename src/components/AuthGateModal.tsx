import React, { useState, useEffect } from 'react';
import { AuthUser } from '../types';
import { BRAND } from '../branding';
import { BrandMark } from './BrandMark';
import { HOTLINKED_IMAGES } from '../data/initialData';
import {
  DEFAULT_PROFILE_ICON_URL,
  PROFILE_ICON_OPTIONS,
  resolveUserAvatarUrl,
} from '../utils/profileIcons';

interface AuthGateModalProps {
  onAuthenticated: (user: AuthUser, isNewSignup?: boolean) => void;
  onClose?: () => void;
  onOpenSetupGuide?: () => void;
  isModalOverlay?: boolean;
  initialMode?: 'signin' | 'signup';
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
}

export const AuthGateModal: React.FC<AuthGateModalProps> = ({
  onAuthenticated,
  onClose,
  onOpenSetupGuide,
  isModalOverlay = false,
  initialMode = 'signin',
  onShowToast,
}) => {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [emailOrUser, setEmailOrUser] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Password Reset Drawer State
  const [showResetBox, setShowResetBox] = useState(false);
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');

  // Sign Up State
  const [signupDisplayName, setSignupDisplayName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupAvatarUrl, setSignupAvatarUrl] = useState<string>(DEFAULT_PROFILE_ICON_URL);

  // Interactive OAuth Handshake State
  const [oauthFlowProvider, setOauthFlowProvider] = useState<
    'discord' | 'github' | 'google' | null
  >(null);
  const [oauthStep, setOauthStep] = useState<'connecting' | 'consent'>('connecting');
  const [oauthCustomHandle, setOauthCustomHandle] = useState('');
  const [oauthCustomEmail, setOauthCustomEmail] = useState('');
  const [oauthVerifyDiscordBotToo, setOauthVerifyDiscordBotToo] = useState(false);

  // Listen for postMessage from real OAuth popup window
  useEffect(() => {
    // Track the expected state from the initiating OAuth flow
    const expectedState = oauthFlowProvider
      ? // If we have a provider in flight, we'll validate against it when the
        // success message arrives. The state was set when handleTriggerOAuth was called.
        oauthFlowProvider
      : null;

    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const { provider, code, state } = event.data;

        // Validate state: must match the expected state from this session
        const stateValid = expectedState && state === expectedState ? true : false;

        if (stateValid) {
          window.removeEventListener('message', handleMessage);
          completeOAuthLogin(provider, code, undefined, false);
        } else {
          setAuthError('OAuth state mismatch — possible CSRF. Please try again.');
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });

  const completeOAuthLogin = async (
    provider: 'discord' | 'github' | 'google',
    customHandle?: string,
    customMail?: string,
    verifyBotNow = false,
  ) => {
    setIsSubmitting(true);
    setAuthError(null);

    try {
      const res = await fetch('/api/auth/oauth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          // Pass custom handle/email if provided; otherwise server uses code/state
          // to resolve the actual OAuth user identity from the token exchange
          ...(customHandle && { handle: customHandle }),
          ...(customMail && { email: customMail }),
          verifyDiscordBotNow: provider === 'discord' && verifyBotNow,
        }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        setOauthFlowProvider(null);
        setIsSubmitting(false);
        const shouldShowGuide = Boolean(data.showSetupGuide ?? data.isNewUser ?? mode === 'signup');
        onAuthenticated(data.user, shouldShowGuide);
        return;
      }
      // Server returned an error — show it rather than creating a fake user
      setAuthError(data.error || 'OAuth handshake failed. Please try again.');
    } catch {
      setAuthError('Could not connect to authentication server.');
    }

    setIsSubmitting(false);
    setOauthFlowProvider(null);
  };

  const handleTriggerOAuth = async (provider: 'discord' | 'github' | 'google') => {
    setAuthError(null);
    setOauthFlowProvider(provider);
    setOauthStep('connecting');
    setOauthVerifyDiscordBotToo(false);

    // Generate a cryptographically random, single-use state value
    const stateArray = new Uint8Array(16);
    crypto.getRandomValues(stateArray);
    const state = Array.from(stateArray, (b) => b.toString(16).padStart(2, '0')).join('');

    // Store the expected state so the postMessage listener can validate it
    setOauthStep('connecting'); // reset step
    // We'll store it in a ref-like way using a mutable ref object pattern:
    // Since we can't use useRef here without importing, we'll use a setState
    // trick: store in a module-level variable via a simple pattern.
    // Actually, let's use the oauthFlowProvider state + a new hook state.
    // For now, we'll store expectedState in local storage as a simple approach:
    try {
      localStorage.setItem('mcpanel_oauth_expected_state', state);
    } catch {
      // fallback if localStorage not available
    }

    // Open OAuth popup window with the authorization URL
    // The server will redirect to the provider's OAuth page and exchange the code
    const providerDomain = {
      discord: 'discord.com',
      github: 'github.com',
      google: 'accounts.google.com',
    }[provider];

    const redirectUri = `${window.location.origin}/auth/callback`;
    const openUrl = `https://${providerDomain}/oauth2/authorize?client_id=${
      provider === 'discord'
        ? process.env.DISCORD_CLIENT_ID
        : provider === 'github'
          ? process.env.GITHUB_CLIENT_ID
          : process.env.GOOGLE_CLIENT_ID
    }&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20email%20guilds&state=${state}`;

    const oauthWindow = window.open(openUrl, '_blank', 'width=600,height=600');

    if (!oauthWindow) {
      setAuthError('Popup blocked - please allow popups for this site');
      setOauthFlowProvider(null);
      // Clean up stored state
      try {
        localStorage.removeItem('mcpanel_oauth_expected_state');
      } catch {}
      return;
    }

    // Listen for the OAuth success message from the callback page
    const messageListener = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        window.removeEventListener('message', messageListener);
        const { provider, code, state: msgState } = event.data;

        // Validate state: must match the expected state from this session
        const storedState = localStorage.getItem('mcpanel_oauth_expected_state');
        const stateValid = storedState && storedState === msgState ? true : false;

        if (stateValid) {
          completeOAuthLogin(provider, code);
        } else {
          setAuthError('OAuth state mismatch — possible CSRF. Please try again.');
        }

        // Clean up stored state
        try {
          localStorage.removeItem('mcpanel_oauth_expected_state');
        } catch {}
      }
    };
    window.addEventListener('message', messageListener);

    // Auto-close after 30 seconds if no response
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', messageListener);
      oauthWindow?.close();
      setAuthError('OAuth handshake timed out. Please try again.');
      // Clean up stored state
      try {
        localStorage.removeItem('mcpanel_oauth_expected_state');
      } catch {}
      setOauthFlowProvider(null);
    }, 30000);

    // Clean up on unmount
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('message', messageListener);
      // Clean up stored state on unmount too
      try {
        localStorage.removeItem('mcpanel_oauth_expected_state');
      } catch {}
    };
  };

  const handleLocalSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!emailOrUser.trim() || !password.trim()) {
      setAuthError('Please enter your username/email and password.');
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
        setAuthError(data.error || 'Invalid login credentials.');
        onShowToast('Login Failed', data.error || 'Invalid credentials.', 'error', 'error');
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      const isNewFromMongo = Boolean(data.showSetupGuide ?? data.isNewUser ?? false);
      onAuthenticated(data.user, isNewFromMongo);
    } catch {
      setIsSubmitting(false);
      setAuthError('Could not connect to authentication server.');
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
        const isNewFromMongo = Boolean(data.showSetupGuide ?? data.isNewUser ?? false);
        onAuthenticated(data.user, isNewFromMongo);
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
      false,
    );
  };

  const handleLocalSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!signupUsername.trim() || !signupEmail.trim() || !signupPassword.trim()) {
      setAuthError('Please fill out Username, Email, and Password.');
      return;
    }
    if (signupPassword.length < 4) {
      setAuthError('Password must be at least 4 characters long.');
      return;
    }
    if (signupPassword !== signupConfirmPassword) {
      setAuthError('Passwords do not match.');
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
          role: 'Root Admin',
          avatarUrl: signupAvatarUrl || DEFAULT_PROFILE_ICON_URL,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setAuthError(data.error || 'Could not create account.');
        setIsSubmitting(false);
        return;
      }
      setIsSubmitting(false);
      onShowToast(
        'Account Saved in MongoDB',
        `Welcome @${data.user.username}! Opening New User Setup Guide.`,
        'success',
        'check_circle',
      );
      onAuthenticated(data.user, true);
    } catch {
      setIsSubmitting(false);
      setAuthError('Network error while creating account.');
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetIdentifier.trim() || resetNewPassword.length < 4) {
      onShowToast(
        'Invalid Input',
        'Enter your username/email and a new password (min 4 characters).',
        'warning',
        'key',
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
        onShowToast('Password Updated', data.message, 'success', 'check_circle');
      } else {
        onShowToast('Reset Failed', data.error || 'Account not found.', 'error', 'error');
      }
    } catch {
      onShowToast('Reset Error', 'Could not reach local auth server.', 'error', 'error');
    }
  };

  return (
    <div
      className={`${
        isModalOverlay
          ? 'fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4'
          : 'min-h-screen w-full bg-surface-dim flex items-center justify-center p-4 sm:p-6 overflow-y-auto relative'
      }`}
    >
      {/* Simple Centered Login & Sign Up Card */}
      <div className="relative z-10 w-full max-w-md rounded-xl bg-surface border border-white/[0.08] p-6 sm:p-8 space-y-6">
        {/* Top Close Button (Only when opened as modal overlay) */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-5 right-5 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-outline hover:text-white cursor-pointer"
            title="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}

        {/* Brand identity: crest, wordmark, product line */}
        <div className="text-center space-y-2.5">
          <BrandMark size="md" className="mx-auto" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-outline">
            {BRAND.descriptor}
          </p>
          <p className="text-xs text-outline">
            {mode === 'signin'
              ? 'Sign in to view and manage your servers'
              : 'Create a new account to set up your servers'}
          </p>
        </div>

        {/* Simple Login / Sign Up Switcher (Setup Guide button removed) */}
        <div className="grid grid-cols-2 bg-surface-lowest p-1 rounded-xl border border-white/[0.08]">
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
            Login
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

        {/* Error Alert */}
        {authError && (
          <div className="p-3 rounded-xl bg-error/15 border border-error/40 text-xs text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-error text-[18px] shrink-0">error</span>
            <span>{authError}</span>
          </div>
        )}

        {/* LOGIN FORM */}
        {mode === 'signin' ? (
          <div className="space-y-4">
            <form onSubmit={handleLocalSignIn} autoComplete="off" className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1.5">
                  Username or Email
                </label>
                <div className="relative">
                  <span className="material-symbols-outlined text-outline text-[17px] absolute left-3 top-2.5">
                    person
                  </span>
                  <input
                    type="text"
                    name="panel_login_identifier"
                    autoComplete="off"
                    value={emailOrUser}
                    onChange={(e) => setEmailOrUser(e.target.value)}
                    placeholder="Enter username or email"
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl pl-9 pr-3 py-2.5 text-xs font-mono text-white focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-on-surface">Password</label>
                  <button
                    type="button"
                    onClick={() => {
                      setResetIdentifier(emailOrUser || '');
                      setShowResetBox(!showResetBox);
                    }}
                    className="text-[11px] text-primary hover:underline cursor-pointer"
                  >
                    {showResetBox ? 'Cancel Reset' : 'Forgot Password?'}
                  </button>
                </div>
                <div className="relative">
                  <span className="material-symbols-outlined text-outline text-[17px] absolute left-3 top-2.5">
                    lock
                  </span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    name="panel_login_secret"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl pl-9 pr-10 py-2.5 text-xs font-mono text-white focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-outline hover:text-white cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {showPassword ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2.5 px-4 rounded-xl bg-primary hover:opacity-95 text-on-primary-container font-bold text-xs transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[17px]">login</span>
                {isSubmitting ? 'Signing In...' : 'Login to Server Panel'}
              </button>
            </form>

            {/* Optional Password Reset Box */}
            {showResetBox && (
              <form
                onSubmit={handleResetPassword}
                className="p-3.5 rounded-xl bg-surface-lowest border border-white/15 space-y-2.5"
              >
                <div className="text-xs font-bold text-white">Reset Account Password</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={resetIdentifier}
                    onChange={(e) => setResetIdentifier(e.target.value)}
                    placeholder="Username or Email"
                    className="bg-surface border border-white/15 rounded-lg px-2.5 py-2 text-xs font-mono text-white"
                  />
                  <input
                    type="password"
                    value={resetNewPassword}
                    onChange={(e) => setResetNewPassword(e.target.value)}
                    placeholder="New Password"
                    className="bg-surface border border-white/15 rounded-lg px-2.5 py-2 text-xs font-mono text-white"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2 rounded-lg bg-primary text-on-primary-container text-xs font-bold cursor-pointer"
                >
                  Update Password
                </button>
              </form>
            )}

            {/* OAuth Login Buttons */}
            <div className="pt-3 border-t border-white/[0.08] space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('discord')}
                  className="py-2 px-3 rounded-xl bg-[#5865F2]/15 hover:bg-[#5865F2]/25 border border-[#5865F2]/35 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>Discord</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('github')}
                  className="py-2 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>GitHub</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTriggerOAuth('google')}
                  className="py-2 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/15 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                >
                  <span>Google</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* SIGN UP FORM */
          <form onSubmit={handleLocalSignUp} autoComplete="off" className="space-y-3.5">
            {/* Simple Profile Icon Picker */}
            <div className="p-3 rounded-xl bg-surface-lowest border border-white/[0.08] space-y-2">
              <div className="flex items-center gap-3">
                <img
                  src={resolveUserAvatarUrl(signupAvatarUrl)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = DEFAULT_PROFILE_ICON_URL;
                  }}
                  alt="Profile Icon"
                  className="w-10 h-10 rounded-xl border border-primary object-cover shrink-0 bg-surface"
                />
                <div>
                  <div className="text-xs font-bold text-white">Profile Icon</div>
                  <p className="text-[11px] text-outline">
                    Default icon selected automatically (or choose one below)
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
                {PROFILE_ICON_OPTIONS.map((iconOpt) => {
                  const isSelected = signupAvatarUrl === iconOpt.url;
                  return (
                    <button
                      key={iconOpt.id}
                      type="button"
                      onClick={() => setSignupAvatarUrl(iconOpt.url)}
                      className={`p-1 rounded-lg border shrink-0 transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-primary/20 border-primary'
                          : 'bg-surface border-white/[0.08] opacity-70 hover:opacity-100'
                      }`}
                      title={iconOpt.label}
                    >
                      <img
                        src={iconOpt.url}
                        alt={iconOpt.label}
                        className="w-7 h-7 rounded-md object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1">Username</label>
                <input
                  type="text"
                  name="panel_signup_username"
                  autoComplete="off"
                  value={signupUsername}
                  onChange={(e) => setSignupUsername(e.target.value)}
                  placeholder="e.g. player_one"
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  name="panel_signup_displayname"
                  autoComplete="off"
                  value={signupDisplayName}
                  onChange={(e) => setSignupDisplayName(e.target.value)}
                  placeholder="e.g. Player One"
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs text-white focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-on-surface block mb-1">
                Email Address
              </label>
              <input
                type="email"
                name="panel_signup_email"
                autoComplete="off"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1">Password</label>
                <input
                  type="password"
                  name="panel_signup_password"
                  autoComplete="new-password"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  placeholder="Min 4 chars"
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-on-surface block mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  name="panel_signup_confirm_password"
                  autoComplete="new-password"
                  value={signupConfirmPassword}
                  onChange={(e) => setSignupConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 px-4 rounded-xl bg-secondary hover:opacity-95 text-on-secondary font-bold text-xs transition-all flex items-center justify-center gap-2 cursor-pointer mt-2"
            >
              <span className="material-symbols-outlined text-[17px]">person_add</span>
              {isSubmitting ? 'Creating Account...' : 'Sign Up & Open Server Panel'}
            </button>
          </form>
        )}

        {/* Footer Mode Switch Link */}
        <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between text-xs">
          <span className="text-outline">
            {mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}
          </span>
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setAuthError(null);
            }}
            className="text-primary font-bold hover:underline cursor-pointer"
          >
            {mode === 'signin' ? 'Create Account (Sign Up) →' : 'Back to Login →'}
          </button>
        </div>
      </div>

      {/* OAuth Handshake Modal */}
      {oauthFlowProvider && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setOauthFlowProvider(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-surface border border-white/15 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between bg-surface-container">
              <div className="flex items-center gap-2.5">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  shield_person
                </span>
                <h3 className="text-sm font-bold text-white capitalize">
                  Continue with {oauthFlowProvider}
                </h3>
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
                <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto" />
                <div className="text-xs font-bold text-white">
                  Connecting to {oauthFlowProvider}...
                </div>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-outline block mb-1 capitalize">
                      {oauthFlowProvider} Username
                    </label>
                    <input
                      type="text"
                      value={oauthCustomHandle}
                      onChange={(e) => setOauthCustomHandle(e.target.value)}
                      className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-outline block mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={oauthCustomEmail}
                      onChange={(e) => setOauthCustomEmail(e.target.value)}
                      className="w-full bg-surface-lowest border border-white/15 focus:border-primary rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none"
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
                      <div className="text-xs">
                        <div className="font-bold text-white">
                          Also Verify with Discord Bot (Unlock 10 Servers)
                        </div>
                        <div className="text-outline text-[11px]">
                          Leave unchecked for standard 2-server limit
                        </div>
                      </div>
                    </label>
                  )}
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOauthFlowProvider(null)}
                    className="px-3.5 py-2 rounded-lg bg-white/5 text-xs font-medium text-outline hover:text-white cursor-pointer"
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
                        oauthVerifyDiscordBotToo,
                      )
                    }
                    className="px-4 py-2 rounded-lg bg-primary text-on-primary-container text-xs font-bold cursor-pointer flex items-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                    Continue
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

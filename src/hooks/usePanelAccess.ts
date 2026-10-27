import { useCallback, useEffect, useRef, useState } from 'react';

export type AdvancedPanelReason =
  | 'access_granted'
  | 'super_admin'
  | 'discord_not_linked'
  | 'not_a_guild_member'
  | 'required_role_missing'
  | 'required_role_not_configured'
  | 'discord_reconnect_required'
  | 'verification_unavailable';

export interface PanelAccessPayload {
  ok: boolean;
  authenticated: boolean;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    isSuperAdmin: boolean;
    maxServerLimit: number;
  };
  panels: {
    simple: { allowed: boolean; reason?: string };
    advanced: {
      allowed: boolean;
      reason: AdvancedPanelReason;
      message: string;
      checkedAt: string | null;
    };
  };
  policy: {
    requiredRoleConfigured: boolean;
    checkTtlSeconds: number;
  };
  discord: {
    linked: boolean;
    discordUserId: string | null;
    username: string | null;
    guildId: string;
    guildName: string;
    inviteUrl: string;
    guildMember: boolean;
    requiredRolePresent: boolean;
    requiredRoleConfigured: boolean;
    lastVerifiedAt: string | null;
    verificationAvailable: boolean;
    /** oauth = this account's own grant, bot = legacy read-only fallback. */
    verificationMode?: 'oauth' | 'bot' | 'none';
    reconnectRequired?: boolean;
    oauthConfigured: boolean;
  };
}

interface PanelAccessState {
  access: PanelAccessPayload | null;
  loading: boolean;
  error: string | null;
  sessionExpired: boolean;
}

/**
 * Reads the entitlement from the backend. This hook is a mirror, never the
 * authority: Advanced Panel features are enforced in Express, so a tampered
 * hook or localStorage value only changes what the UI offers, not what works.
 */
export function usePanelAccess(userId?: string) {
  const [state, setState] = useState<PanelAccessState>({
    access: null,
    loading: false,
    error: null,
    sessionExpired: false,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (mode: 'auto' | 'force'): Promise<PanelAccessPayload | null> => {
      if (!userId) {
        if (mounted.current) {
          setState({ access: null, loading: false, error: null, sessionExpired: false });
        }
        return null;
      }
      if (mounted.current) {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const res = await fetch(
          mode === 'force' ? '/api/account/access/refresh' : '/api/account/access',
          {
            method: mode === 'force' ? 'POST' : 'GET',
            credentials: 'include',
            headers: mode === 'force' ? { 'Content-Type': 'application/json' } : undefined,
            body: mode === 'force' ? '{}' : undefined,
          },
        );
        const data = (await res.json().catch(() => null)) as
          | (PanelAccessPayload & { error?: string; code?: string })
          | null;

        if (res.status === 401) {
          if (mounted.current) {
            setState({
              access: null,
              loading: false,
              error: data?.error || 'Your session has expired. Sign in again.',
              sessionExpired: true,
            });
          }
          return null;
        }
        if (res.status === 429) {
          // A double click on "Check verification" is normal; keep the last
          // decision and surface the cooldown without clearing the panel.
          if (mounted.current) {
            setState((prev) => ({
              ...prev,
              loading: false,
              error: data?.error || 'Discord was just checked. Try again in a second.',
            }));
          }
          return null;
        }
        if (!res.ok || !data?.ok) {
          if (mounted.current) {
            setState((prev) => ({
              ...prev,
              loading: false,
              error: data?.error || `Access check failed (HTTP ${res.status}).`,
            }));
          }
          return null;
        }
        if (mounted.current) {
          setState({ access: data, loading: false, error: null, sessionExpired: false });
        }
        return data;
      } catch {
        if (mounted.current) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: 'Could not reach the local backend to check panel access.',
          }));
        }
        return null;
      }
    },
    [userId],
  );

  useEffect(() => {
    void load('auto');
  }, [load]);

  const refresh = useCallback(() => load('force'), [load]);
  const reload = useCallback(() => load('auto'), [load]);

  return {
    access: state.access,
    loading: state.loading,
    error: state.error,
    sessionExpired: state.sessionExpired,
    refresh,
    reload,
  };
}

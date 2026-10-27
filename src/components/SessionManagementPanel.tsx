/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { AuthUser } from '../types';

export interface SessionInfo {
  sessionId: string;
  userId: string;
  username: string;
  role: string;
  provider: string;
  ipAddress: string;
  platform: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionManagementPanelProps {
  currentUser: AuthUser | null;
  onShowToast?: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  onSignOut?: () => void;
}

const SessionManagementPanel: React.FC<SessionManagementPanelProps> = ({
  currentUser,
  onShowToast,
  onSignOut,
}) => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    if (!currentUser) {
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await fetch('/api/auth/sessions', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok && data?.sessions) {
        setSessions(data.sessions);
      } else {
        setSessions([]);
        if (onShowToast) {
          onShowToast('Sessions', 'Failed to load sessions.', 'error');
        }
      }
    } catch (err) {
      setSessions([]);
      if (onShowToast) {
        onShowToast('Sessions', 'Error loading sessions.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [currentUser, onShowToast]);

  useEffect(() => {
    fetchSessions();
    // Poll sessions every 10 seconds to keep UI updated
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const handleRevokeSession = useCallback(
    async (sessionId: string) => {
      setRevoking(sessionId);
      try {
        const res = await fetch('/api/auth/sessions/revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ sessionId }),
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          if (onShowToast) {
            onShowToast('Session Revoked', 'Session has been revoked.', 'success');
          }
          fetchSessions();
        } else {
          if (onShowToast) {
            onShowToast(
              'Session Revoke Failed',
              data?.error || 'Failed to revoke session.',
              'error',
            );
          }
        }
      } catch (err) {
        if (onShowToast) {
          onShowToast('Session Revoke Error', 'Network error while revoking session.', 'error');
        }
      } finally {
        setRevoking(null);
      }
    },
    [onShowToast, fetchSessions],
  );

  const handleRevokeOthers = useCallback(async () => {
    if (!currentUser) return;
    if (
      !window.confirm(
        'Sign out from all other devices? This will keep your current session active.',
      )
    )
      return;
    setRevoking('others');
    try {
      const res = await fetch('/api/auth/sessions/revoke-others', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        if (onShowToast) {
          onShowToast('Signed Out Other Devices', 'Signed out from all other devices.', 'success');
        }
        fetchSessions();
      } else {
        if (onShowToast) {
          onShowToast(
            'Sign Out Failed',
            data?.error || 'Failed to sign out other devices.',
            'error',
          );
        }
      }
    } catch (err) {
      if (onShowToast) {
        onShowToast('Sign Out Error', 'Network error while signing out other devices.', 'error');
      }
    } finally {
      setRevoking(null);
    }
  }, [currentUser, onShowToast, fetchSessions]);

  const handleSignOutAll = useCallback(async () => {
    if (!window.confirm('Sign out from ALL devices including this one?')) return;
    setRevoking('all');
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ logoutCurrentOnly: false }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        if (onShowToast) {
          onShowToast('Signed Out Everywhere', 'Signed out from all devices.', 'success');
        }
        setSessions([]);
        if (onSignOut) {
          onSignOut();
        }
      } else {
        if (onShowToast) {
          onShowToast('Sign Out Failed', data?.error || 'Failed to sign out everywhere.', 'error');
        }
      }
    } catch (err) {
      if (onShowToast) {
        onShowToast('Sign Out Error', 'Network error while signing out everywhere.', 'error');
      }
    } finally {
      setRevoking(null);
    }
  }, [onShowToast, onSignOut, fetchSessions]);

  // Identify the current session - the one most recently active
  useEffect(() => {
    if (sessions.length > 0) {
      // Sort by lastActiveAt descending, the most recent is the current session
      const sorted = [...sessions].sort(
        (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
      );
      setCurrentSessionId(sorted[0].sessionId);
    }
  }, [sessions]);

  if (!currentUser) {
    return null;
  }

  return (
    <div className="rounded-xl bg-surface border border-white/[0.06] text-on-surface font-sans antialiased">
      <div className="kp-head">
        <div>
          <h2 className="kp-title">Active sessions</h2>
          <p className="kp-sub">{sessions.length} signed-in device(s)</p>
        </div>
        <button
          onClick={handleSignOutAll}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11px] font-medium text-on-surface transition-colors cursor-pointer disabled:opacity-50"
          disabled={revoking === 'all'}
        >
          <span className="material-symbols-outlined text-[15px]">logout</span>
          {revoking === 'all' ? 'Signing out...' : 'Sign out everywhere'}
        </button>
      </div>

      {loading ? (
        <div className="p-4 text-[11.5px] font-mono text-outline">Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <p className="p-4 text-[11.5px] text-outline">No active sessions found.</p>
      ) : (
        <div className="p-4 pt-3 space-y-2">
          {sessions.map((session: SessionInfo) => {
            const isCurrent = session.sessionId === currentSessionId;
            const timeSinceLastActive = calculateTimeSince(new Date(session.lastActiveAt));
            const timeSinceCreated = calculateTimeSince(new Date(session.createdAt));

            return (
              <div
                key={session.sessionId}
                className={`p-3 rounded-lg border ${isCurrent ? 'border-primary/35 bg-primary/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[12.5px] font-medium text-white truncate">
                      {session.username} • {session.platform || 'Unknown'}
                    </h3>
                    <p className="text-[11px] font-mono text-outline truncate mt-0.5">
                      {session.ipAddress || 'Unknown IP'} · {timeSinceLastActive} active ·{' '}
                      {timeSinceCreated} created
                    </p>
                  </div>
                  <span className="font-mono text-[10.5px] text-outline shrink-0">
                    {formatTime(session.lastActiveAt)}
                  </span>
                </div>

                <div className="mt-2.5 flex items-center gap-3">
                  {isCurrent ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
                      <span className="size-1.5 rounded-full bg-secondary" />
                      current session
                    </span>
                  ) : (
                    <button
                      onClick={() =>
                        window.confirm(`Revoke session for ${session.username}?`) &&
                        handleRevokeSession(session.sessionId)
                      }
                      className="text-[11px] font-medium text-error hover:brightness-125 transition-all cursor-pointer"
                      title="Revoke this session"
                    >
                      Revoke
                    </button>
                  )}

                  <button
                    onClick={handleRevokeOthers}
                    className="text-[11px] font-medium text-outline hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                    disabled={revoking === 'others'}
                    title="Sign out from other devices"
                  >
                    {revoking === 'others' ? 'Signing out...' : 'Sign out other devices'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function calculateTimeSince(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  }
  if (diffHours > 0) {
    return `${diffHours}h ago`;
  }
  if (diffMinutes > 0) {
    return `${diffMinutes}min ago`;
  }
  return 'just now';
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default SessionManagementPanel;

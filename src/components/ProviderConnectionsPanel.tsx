import React, { useEffect, useState } from 'react';
import { NavSection, AuthUser } from '../types';
import { DEFAULT_PROFILE_ICON_URL, resolveUserAvatarUrl } from '../utils/profileIcons';
import { LogOut, Link } from 'lucide-react';

interface ProviderData {
  provider: 'local' | 'discord' | 'github' | 'google';
  connected: boolean;
  username: string;
  displayName: string;
  role: AuthUser['role'];
  avatarUrl: string;
  providerData: Record<string, any>;
}

interface ProviderConnectionsPanelProps {
  currentUser: AuthUser | null;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  onSignOut: () => void;
}

const ProviderConnectionsPanel: React.FC<ProviderConnectionsPanelProps> = ({
  currentUser,
  onShowToast,
  onSignOut,
}) => {
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    fetch('/api/auth/providers', {
      credentials: 'include',
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to load provider connections');
        }
        return response.json();
      })
      .then((data: { ok: boolean; providers: ProviderData[] }) => {
        if (data.ok && data.providers) {
          setProviders(data.providers);
        } else {
          throw new Error('Invalid provider data received');
        }
      })
      .catch((err) => {
        console.error('Failed to fetch provider connections:', err);
        setError('Failed to load provider connections');
        onShowToast(
          'Provider Connections',
          'Failed to load OAuth provider connections. Please try again.',
          'warning',
        );
      })
      .finally(() => setLoading(false));
  }, [currentUser, onShowToast]);

  const handleDisconnect = async (provider: ProviderData['provider']) => {
    if (provider === 'local') return;
    if (!window.confirm(`Are you sure you want to disconnect ${provider}?`)) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/provider/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ provider }),
      });

      const data = await res.json();

      if (data.ok) {
        onShowToast(
          'Provider Disconnected',
          `${provider.charAt(0).toUpperCase() + provider.slice(1)} has been disconnected successfully.`,
          'success',
        );
        // Refresh provider list
        fetch('/api/auth/providers', {
          credentials: 'include',
        })
          .then((r) => r.json())
          .then((d: { ok: boolean; providers: ProviderData[] }) => {
            if (d.ok && d.providers) setProviders(d.providers);
          })
          .catch(() => {});
      } else {
        onShowToast(
          'Disconnection Failed',
          data.error || 'Failed to disconnect provider. Please try again.',
          'error',
        );
      }
    } catch (err) {
      console.error('Error disconnecting provider:', err);
      onShowToast(
        'Disconnection Failed',
        'An error occurred while disconnecting the provider.',
        'error',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (provider: 'discord' | 'github' | 'google') => {
    try {
      const res = await fetch(`/api/auth/provider/link/${provider}`, {
        method: 'POST',
        credentials: 'include',
      });

      const data = await res.json();

      if (data.ok && data.url) {
        // Open OAuth URL in a new window/popup
        const authWindow = window.open(data.url, 'OAuth Authorization', 'width=500,height=600');

        if (authWindow) {
          // Listen for messages from the popup (if using popup OAuth flow)
          const handleMessage = (event: MessageEvent) => {
            if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
              // OAuth successful, refresh provider list
              fetch('/api/auth/providers', {
                credentials: 'include',
              })
                .then((r) => r.json())
                .then((d: { ok: boolean; providers: ProviderData[] }) => {
                  if (d.ok && d.providers) setProviders(d.providers);
                  onShowToast(
                    'Provider Connected',
                    `${provider.charAt(0).toUpperCase() + provider.slice(1)} has been connected successfully.`,
                    'success',
                  );
                })
                .catch(() => {
                  onShowToast(
                    'Connection Failed',
                    'Failed to update provider list after connection.',
                    'error',
                  );
                });

              // Remove event listener
              window.removeEventListener('message', handleMessage);
              authWindow.close();
            }
          };

          window.addEventListener('message', handleMessage);

          // Also handle redirect-based OAuth flow by checking periodically
          const checkAuthStatus = async () => {
            try {
              const res = await fetch('/api/auth/providers', {
                credentials: 'include',
              });
              const data = await res.json();
              if (data.ok && data.providers) {
                const providerData = data.providers.find(
                  (p: ProviderData) => p.provider === provider,
                );
                if (providerData && providerData.connected) {
                  setProviders(data.providers);
                  onShowToast(
                    'Provider Connected',
                    `${provider.charAt(0).toUpperCase() + provider.slice(1)} has been connected successfully.`,
                    'success',
                  );
                  clearInterval(authCheckInterval);
                }
              }
            } catch (err) {
              console.error('Error checking auth status:', err);
            }
          };

          const authCheckInterval = setInterval(checkAuthStatus, 2000);

          // Stop checking after 2 minutes
          setTimeout(() => {
            clearInterval(authCheckInterval);
            onShowToast(
              'Connection Timeout',
              'OAuth connection timed out. Please try again.',
              'warning',
            );
          }, 120000);
        } else {
          // Fallback to redirect if popup blocked
          window.location.href = data.url;
        }
      } else {
        onShowToast(
          'Connection Failed',
          data.error || 'Failed to initiate provider connection. Please try again.',
          'error',
        );
      }
    } catch (err) {
      console.error('Error connecting provider:', err);
      onShowToast('Connection Failed', 'An error occurred while connecting the provider.', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <div className="rounded-xl bg-surface border border-white/[0.06]">
      <div className="kp-head">
        <div>
          <h3 className="kp-title">Provider connections</h3>
          <p className="kp-sub">Linked sign-in providers for this operator</p>
        </div>
        <button
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-error/25 bg-error/10 hover:bg-error/20 text-[11px] font-medium text-error transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[15px]">logout</span>
          Sign out
        </button>
      </div>

      {loading && <p className="px-4 pt-3 text-[11.5px] font-mono text-outline">Loading provider connections...</p>}

      {error && <p className="px-4 pt-3 text-[11.5px] text-error">{error}</p>}

      <div className="p-4 pt-3 space-y-3">
        {/* Current Login Method */}
        <div>
          <p className="kp-label mb-1.5">Current login method</p>
          <div className="flex items-center gap-2">
            {providers.find((p) => p.provider === 'local') ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-secondary/25 bg-secondary/10 text-secondary font-mono text-[10.5px]">
                <span className="size-1.5 rounded-full bg-secondary" />
                {providers.find((p) => p.provider === 'local')?.displayName}
              </span>
            ) : null}
          </div>
        </div>

        {/* Connected Providers List */}
        {providers.map((provider) => {
          if (provider.provider === 'local') return null;

          const isConnected = provider.connected;
          const ConnBtn = isConnected ? 'Disconnect' : 'Connect';

          return (
            <div
              key={provider.provider}
              className="flex items-center gap-2.5 p-2 rounded-lg border border-white/[0.06] bg-white/[0.02]"
            >
              <div className="size-7 rounded-md bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 overflow-hidden">
                {provider.avatarUrl ? (
                  <img
                    src={provider.avatarUrl}
                    alt={provider.displayName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-[11px] font-semibold text-on-surface">
                    {provider.displayName.charAt(0)}
                  </span>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-white truncate">
                  {provider.displayName}
                </div>
                <div className="text-[10.5px] font-mono text-outline truncate">
                  {provider.username}
                </div>
              </div>

              <button
                onClick={() => handleDisconnect(provider.provider)}
                disabled={loading}
                className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[10.5px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                  isConnected
                    ? 'bg-error/10 hover:bg-error/20 text-error border-error/25'
                    : 'bg-white/[0.03] hover:bg-white/[0.07] text-on-surface border-white/10'
                }`}
                title={
                  isConnected
                    ? 'Disconnect ' + provider.displayName
                    : 'Connect ' + provider.displayName
                }
              >
                {isConnected ? <LogOut className="w-3 h-3" /> : <Link className="w-3 h-3" />}
                <span className="whitespace-nowrap">{ConnBtn}</span>
              </button>
            </div>
          );
        })}

      </div>
    </div>
  );
};

export default ProviderConnectionsPanel;

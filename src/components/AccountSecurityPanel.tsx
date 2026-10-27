import React, { useState } from 'react';
import { AuthUser } from '../types';

interface AccountSecurityPanelProps {
  currentUser: AuthUser | null;
  onShowToast: (
    title: string,
    body?: string,
    type?: 'success' | 'info' | 'warning' | 'error',
    icon?: string,
  ) => void;
  onSignOut: () => void;
}

const AccountSecurityPanel: React.FC<AccountSecurityPanelProps> = ({
  currentUser,
  onShowToast,
  onSignOut,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [show2faSetup, setShow2faSetup] = useState(false);
  const [enable2fa, setEnable2fa] = useState(false);

  const handleChangePassword = async () => {
    if (!currentUser) return;

    if (newPassword.length < 4) {
      onShowToast('Password Too Short', 'Password must be at least 4 characters long.', 'error');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      onShowToast('Passwords Do Not Match', 'Please confirm your new password correctly.', 'error');
      return;
    }

    setChangingPassword(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        onShowToast('Password Changed', 'Your password has been updated successfully.', 'success');
        // Clear form
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        // Force re-login for security
        onSignOut();
      } else {
        onShowToast('Password Change Failed', data.error || 'Failed to change password.', 'error');
      }
    } catch (err) {
      onShowToast('Network Error', 'An error occurred while changing your password.', 'error');
    } finally {
      setChangingPassword(false);
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <div className="rounded-xl bg-surface border border-white/[0.06]">
      <div className="kp-head">
        <div>
          <h3 className="kp-title">Account security</h3>
          <p className="kp-sub">Password, two-factor authentication and session policy</p>
        </div>
      </div>

      <div className="p-4 pt-3 space-y-4">
        {/* Change Password Section */}
        <div>
          <p className="kp-label mb-2">Change password</p>
          <div className="grid grid-cols-1 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-outline">Current password</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={changingPassword}
                className={`h-8 px-2.5 rounded-lg bg-white/[0.03] border border-white/10 text-[12px] text-white placeholder:text-outline focus:outline-none focus:border-primary/60 transition-colors ${
                  changingPassword ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                placeholder="Enter current password"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-outline">New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={changingPassword}
                className={`h-8 px-2.5 rounded-lg bg-white/[0.03] border border-white/10 text-[12px] text-white placeholder:text-outline focus:outline-none focus:border-primary/60 transition-colors ${
                  changingPassword ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                placeholder="Enter new password (min 4 characters)"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-outline">Confirm new password</span>
              <input
                type="password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                disabled={changingPassword}
                className={`h-8 px-2.5 rounded-lg bg-white/[0.03] border border-white/10 text-[12px] text-white placeholder:text-outline focus:outline-none focus:border-primary/60 transition-colors ${
                  changingPassword ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                placeholder="Confirm new password"
              />
            </label>
            <button
              onClick={handleChangePassword}
              disabled={changingPassword}
              className={`inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-primary hover:brightness-105 text-[11.5px] font-semibold text-on-primary transition-all cursor-pointer ${
                changingPassword ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {changingPassword ? 'Changing...' : 'Change Password'}
            </button>
          </div>
        </div>

        {/* Two-Factor Authentication Section (Placeholder) */}
        <div>
          <p className="kp-label mb-2">Two-factor authentication</p>
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-white truncate">
                Authenticator app
              </div>
              <div className="text-[11px] text-outline truncate">
                Google Authenticator, Authy or 1Password
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enable2fa}
              aria-label="Enable two-factor authentication"
              onClick={() => setEnable2fa((v) => !v)}
              disabled={show2faSetup}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 cursor-pointer disabled:opacity-50 ${
                enable2fa ? 'bg-primary' : 'bg-white/15'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${
                  enable2fa ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          {show2faSetup && (
            <div className="mt-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
              <p className="text-[11px] text-outline">
                2FA setup is coming soon. You will scan a QR code with your authenticator app.
              </p>
              <div className="mt-2 flex justify-center">
                <div className="size-10 border border-white/10 rounded-md bg-white/[0.03] flex items-center justify-center font-mono text-[10px] text-outline">
                  QR
                </div>
              </div>
              <button
                onClick={() => setShow2faSetup(false)}
                className="mt-2.5 inline-flex items-center justify-center h-7 px-3 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-[11px] font-medium text-on-surface transition-colors cursor-pointer"
              >
                Close setup
              </button>
            </div>
          )}
        </div>

        {/* Security Settings Section */}
        <div>
          <p className="kp-label mb-2">Security settings</p>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] divide-y divide-white/[0.05]">
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[11.5px] text-[#c9d2e2]">
                Password required for sensitive actions
              </span>
              <span className="font-mono text-[10.5px] text-secondary">enabled</span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[11.5px] text-[#c9d2e2]">Login notifications</span>
              <span className="font-mono text-[10.5px] text-secondary">enabled</span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[11.5px] text-[#c9d2e2]">Active sessions limit</span>
              <span className="font-mono text-[10.5px] text-outline">5 sessions</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AccountSecurityPanel;

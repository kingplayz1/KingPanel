/**
 * Default Profile Icon & Preset Operator Profile Icons
 * Used across Signup, Login, Sidebar, Pre-Panel, Panel Control, and MongoDB User Documents.
 */

// Crisp SVG Data URI Default Profile Icon (Golden Crown Operator Shield on Obsidian Gradient)
export const DEFAULT_PROFILE_ICON_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#1E2536"/>
        <stop offset="100%" stop-color="#0B0F17"/>
      </linearGradient>
      <linearGradient id="gold" x1="20" y1="20" x2="108" y2="108" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFE088"/>
        <stop offset="50%" stop-color="#F59E0B"/>
        <stop offset="100%" stop-color="#D97706"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#bg)"/>
    <rect x="4" y="4" width="120" height="120" rx="24" stroke="url(#gold)" stroke-opacity="0.45" stroke-width="3"/>
    <circle cx="64" cy="50" r="20" fill="url(#gold)"/>
    <path d="M28 106C28 86.1177 44.1177 70 64 70C83.8823 70 100 86.1177 100 106V110H28V106Z" fill="url(#gold)"/>
    <path d="M44 26L54 36L64 20L74 36L84 26L80 40H48L44 26Z" fill="#FFE088"/>
  </svg>`
)}`;

export interface ProfileIconOption {
  id: string;
  label: string;
  badge: string;
  url: string;
}

export const PROFILE_ICON_OPTIONS: ProfileIconOption[] = [
  {
    id: 'default-operator',
    label: 'Default Operator Crest',
    badge: 'Default',
    url: DEFAULT_PROFILE_ICON_URL,
  },
  {
    id: 'cyber-emerald',
    label: 'Emerald Core Guardian',
    badge: 'DevOps',
    url: `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
        <rect width="128" height="128" rx="28" fill="#0B1917"/>
        <rect x="4" y="4" width="120" height="120" rx="24" stroke="#4EDEA3" stroke-opacity="0.5" stroke-width="3"/>
        <circle cx="64" cy="50" r="20" fill="#4EDEA3"/>
        <path d="M28 106C28 86.1177 44.1177 70 64 70C83.8823 70 100 86.1177 100 106V110H28V106Z" fill="#10B981"/>
        <polygon points="64,16 74,28 64,40 54,28" fill="#A7F3D0"/>
      </svg>`
    )}`,
  },
  {
    id: 'crimson-root',
    label: 'Redstone Root Architect',
    badge: 'Admin',
    url: `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
        <rect width="128" height="128" rx="28" fill="#1F0D14"/>
        <rect x="4" y="4" width="120" height="120" rx="24" stroke="#F43F5E" stroke-opacity="0.5" stroke-width="3"/>
        <circle cx="64" cy="50" r="20" fill="#FB7185"/>
        <path d="M28 106C28 86.1177 44.1177 70 64 70C83.8823 70 100 86.1177 100 106V110H28V106Z" fill="#E11D48"/>
        <rect x="56" y="18" width="16" height="10" rx="3" fill="#FDA4AF"/>
      </svg>`
    )}`,
  },
  {
    id: 'mc-alex',
    label: 'Alex (MC Skin)',
    badge: 'Minecraft',
    url: 'https://mc-heads.net/avatar/MHF_Alex/128',
  },
  {
    id: 'mc-steve',
    label: 'Steve (MC Skin)',
    badge: 'Minecraft',
    url: 'https://mc-heads.net/avatar/MHF_Steve/128',
  },
  {
    id: 'mc-notch',
    label: 'Notch (Super Admin)',
    badge: 'Legend',
    url: 'https://mc-heads.net/avatar/Notch/128',
  },
];

export function resolveUserAvatarUrl(avatarUrl?: string | null): string {
  if (!avatarUrl || !String(avatarUrl).trim()) {
    return DEFAULT_PROFILE_ICON_URL;
  }
  return String(avatarUrl).trim();
}

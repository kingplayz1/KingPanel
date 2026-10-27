export type NavSection =
  | 'overview'
  | 'setup_guide'
  | 'console'
  | 'files'
  | 'plugins'
  | 'logs'
  | 'network'
  | 'backups'
  | 'schedules'
  | 'databases'
  | 'jvm'
  | 'settings'
  | 'panel_control'
  | 'privacy'
  | 'terms'
  | 'account'
  | 'not_found';

export interface ServerInstance {
  id: string;
  name: string;
  engine: string;
  javaVersion: string;
  port: number;
  pid: number;
  status: 'running' | 'restarting' | 'stopped';
  path: string;
  build: string;
  tps: number;
  tickMs: number;
  uptime: string;
  playersOnline: number;
  maxPlayers: number;
  cpuUsage: number;
  cpuTemp: number;
  ramUsedGb: number;
  ramMaxGb: number;
  // PaperMC Background Version Check Service Flags
  installedVersion?: string;
  latestVersion?: string;
  isOutdated?: boolean;
  latestBuild?: string;
  lastVersionCheckAt?: string;
  downloadUrl?: string;
}

export interface PaperMCServiceReport {
  serviceStatus: 'RUNNING' | 'CHECKING' | 'ERROR';
  intervalSeconds: number;
  lastCheckedAt: string;
  nextCheckAt: string;
  totalChecksRun: number;
  latestPaperRelease: string;
  latestPaperBuild: string;
  latestPaperDownloadUrl: string;
  outdatedCount: number;
  engines: Record<
    string,
    {
      engineName: string;
      latestRelease: string;
      latestBuild: string;
      totalReleases: number;
      apiSource: string;
    }
  >;
  serverReports: Record<
    string,
    {
      serverId: string;
      serverName: string;
      engineFamily: string;
      installedVersion: string;
      latestVersion: string;
      latestBuild: string;
      isOutdated: boolean;
      downloadUrl: string;
      checkedAt: string;
    }
  >;
}

export interface ToastMessage {
  id: string;
  title: string;
  body?: string;
  type: 'success' | 'info' | 'warning' | 'error';
  icon?: string;
}

export interface ConsoleLogLine {
  id: string;
  time: string;
  level: 'INFO' | 'UPnP' | 'WARN' | 'JOIN' | 'ERROR' | 'CHAT' | 'EXEC' | 'BROADCAST';
  text: string;
  highlightBox?: 'warn' | 'join' | 'error' | 'broadcast';
  sender?: string;
}

export interface ConnectedPlayer {
  id: string;
  username: string;
  initials: string;
  colorClass: string;
  role: 'Owner' | 'Admin' | 'Moderator' | 'Member';
  dimension: string;
  ping: number;
  uuid: string;
  avatarUrl: string;
  online: boolean;
}

export interface FileItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: string;
  permissions?: string;
  icon: string;
  iconColor: string;
  badge?: string;
  children?: FileItem[];
  content?: string;
  language?: 'yaml' | 'properties' | 'csv' | 'text';
  modifiedAt?: string;
  encoding?: string;
}

export interface PluginItem {
  id: string;
  code: string;
  codeColor: string;
  name: string;
  author: string;
  category: string;
  filterCategory: string;
  source: 'Modrinth' | 'SpigotMC' | 'CurseForge' | 'Paper Hangar';
  description: string;
  rating: string;
  downloads: string;
  version: string;
  targetVersion?: string;
  status: 'update_ready' | 'installed' | 'available';
  extraTag: string;
  footerLeft: string;
  fullWidth?: boolean;
}

export interface PortRule {
  port: number;
  proto: 'TCP' | 'UDP' | 'TCP/UDP';
  serviceName: string;
  badge?: string;
  badgeColor?: string;
  target: string;
  bindingType: string;
  bindingColor: string;
  bindingIcon: string;
  throughput: string;
  activeLoad: string;
  loadColor: string;
  status: 'OPEN' | 'SSL SECURE' | 'NO WAN';
  statusNote?: string;
  category: 'game' | 'http' | 'internal';
  serverId?: string;
}

export interface SnapshotItem {
  id: string;
  title: string;
  badge: string;
  badgeType: 'primary' | 'tertiary' | 'gold' | 'neutral';
  verified?: boolean;
  pinned?: boolean;
  timestamp: string;
  size: string;
  note?: string;
  scopes: string[];
  destination: string;
  cloudDest?: string;
  sha?: string;
  icon: string;
  iconColor: string;
  serverId?: string;
}

export interface CronTask {
  id: string;
  title: string;
  cron: string;
  status: 'Active' | 'Weekly' | 'Paused';
  description: string;
  nextRun: string;
  actionLabel: string;
  icon: string;
  iconColor: string;
  serverId?: string;
}

export type AuthProviderType = 'local' | 'discord' | 'github' | 'google';

export type DiscordGuildMemberStatus =
  | 'not_connected'
  | 'pending_bot_verify'
  | 'verified_in_guild'
  | 'left_guild';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: 'Super Admin' | 'Root Admin' | 'DevOps Engineer' | 'Moderator' | 'Operator';
  isSuperAdmin?: boolean;
  provider: AuthProviderType;
  avatarUrl: string;
  mcUuid?: string;
  connectedProviders: AuthProviderType[];
  lastLogin: string;
  sessionSha: string;
  // Discord Server & Bot Verification + Server Creation Limit Logic
  discordVerified?: boolean;
  discordMemberStatus?: DiscordGuildMemberStatus;
  discordUserId?: string;
  discordUsername?: string;
  discordGuildId?: string;
  discordGuildName?: string;
  discordInviteUrl?: string;
  discordBotVerifiedAt?: string;
  maxServerLimit?: number; // Default 2 for all logged-in users; 10 when Discord Bot Verified; 999 for Super Admin kingplayz
}


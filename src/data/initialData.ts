import {
  ServerInstance,
  ConsoleLogLine,
  ConnectedPlayer,
  FileItem,
  PluginItem,
  PortRule,
  SnapshotItem,
  CronTask,
} from '../types';

// Start with zero pre-installed servers; servers are only added when the user creates one
export const INITIAL_SERVERS: ServerInstance[] = [];

// Safe empty fallback server object when the user has not created any servers yet
export const EMPTY_SERVER_PLACEHOLDER: ServerInstance = {
  id: 'no-server',
  name: 'No Server Installed',
  engine: 'PaperMC 1.21.4',
  javaVersion: 'Java 21',
  port: 25565,
  pid: 0,
  status: 'stopped',
  tps: 0.0,
  tickMs: 0.0,
  uptime: 'No Server Created Yet',
  playersOnline: 0,
  maxPlayers: 20,
  cpuUsage: 0,
  cpuTemp: 0,
  ramUsedGb: 0.0,
  ramMaxGb: 4,
  path: 'C:\\KingServers',
  build: 'Not Installed',
  installedVersion: '1.21.4',
  latestVersion: '1.21.4',
  isOutdated: false,
  latestBuild: 'Build #222',
};

export const INITIAL_CONSOLE_LOGS: ConsoleLogLine[] = [];

export const INITIAL_PLAYERS: ConnectedPlayer[] = [];

// No placeholder file tree: the advanced file manager loads real server files.
export const INITIAL_FILES: FileItem[] = [];

export const INITIAL_PLUGINS: PluginItem[] = [];

export const INITIAL_PORTS: PortRule[] = [];

export const INITIAL_SNAPSHOTS: SnapshotItem[] = [];

export const INITIAL_CRONS: CronTask[] = [];

export const HOTLINKED_IMAGES = {
  avatarMio: 'https://mc-heads.net/avatar/MHF_Steve/128',
  avatarAki: 'https://mc-heads.net/avatar/MHF_Steve/128',
  avatarKuro: 'https://mc-heads.net/avatar/MHF_Steve/128',
  avatarVoxel: 'https://mc-heads.net/avatar/MHF_Steve/128',
  serverFavicon: 'https://mc-heads.net/avatar/MHF_Steve/64',
  adminProfile: 'https://mc-heads.net/avatar/MHF_Steve/128',
  serverIcon64: 'https://mc-heads.net/avatar/MHF_Steve/64',
};

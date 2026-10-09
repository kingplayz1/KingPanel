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

export const HOTLINKED_IMAGES = {
  serverIcon64:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuA8rh2kq8V7MXXa9_iUMEYKh3Vs4cwuZHhMkoiTyWsE64madogkXHOQIDZC42C_aEZeU1wu-UfWyYMd73JyaUpA0j-9TjdaN0-ASpTGGHtNLrh3kMk7feLIZ1ebcCpkffqqQLuy06-HN29t4HPrUEDwt57DwdZh6l6zlBRzTrp1-3g8jEhk0asCM_Nwa6Rv9UaDyqcrKO7odUb3h66dUEEnfAZGR7e5KCFHQ0KRY6Rg0gSaxvJhEKCwmw',
  avatarMio:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAyOwGiYfgrnQmU1kdyTROFFzhSf5L23Gi_HARYStupvm2m2SeGODY53LrofBoGWP_cvcVOjMv9PgKZR621-kRRVxm2mMJ8koTwXveWNEuUkFJZ-r4smtlGKoCKIMIFtFIHUfqG3y4fFsYa35ASlWuDMZEvAhui07wL1swWa0gBu39wTTyH-wGK4TQB4Xiyh2zu1RUwzoPM5tStZ47xYyieB9ukou4RqbmWM95ZaaufTpPlUR2zHokiGg',
  avatarAki:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAgsbDa5UVM9jv94b-r7lS42XFvWbUyiuTSQs49eOU2lvdaAguYgA1hn-Qpfz2_6TX2Tl0QIh4sQLZI6jbSJKpbfKN_D4ydayXA0i70TRSGoOo1k0kaQ7q-jeqhrekeIGbrz9tlS8oTT-SZEpfr4iftgEJflf3z2zYx7zjcjUpJxLMr6W8jbgNwg0o2dJueq3SjdqCAUgi8QgMqz62lHSQKFz1T3SMtF6_sFCCnEaNUM8vsd1mka3a_iw',
  avatarKuro:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBcxzEqkOsqqzTruriIikrjG43sZn0LXUpW2VRrhZs_vtUIwJ62RAJ1AuT1yNfAPJ2JSLKlKz973QGrQ9x2Tvn7SpZtd0Nvfp2B2tYXJBTo-vuqTBGEUSXl4yse_WJWppqnvVs0j1TmFId4TzJMUD_syTXuOQAFqmiZLlmH3r6mMv2wvYTkiYlgNoI18yi2cvVTJrtBmP5JrMYdzG3C2AQbMajNb6MIc1HGf2S_CwKG9lYbMRpxi8leoQ',
  avatarVoxel:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAF9ZnSG495CNWBiWUtnlVLyZDq3p3GXKAl51cltH3dyhSK-DViyC16IGSqHqDx3FfEplX0YMijUOZ9SppTZbfn9ls1RcU5oaXmZ-6imnToIHg98kv9x6MzjXZuezv3S2r4qkv4beuSE_DU2dl5dnI9Z0UU8pwoSF41w_LbHy9KZIRyfnQ2VAevJqCLvTrOG7j4To16-VN0ijzyPzh9KJgUvgcp7AI1vLdU2OoJmdSZb7JvgxrQjKkLhQ',
  voxelOrbAvatar:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBM3C_ILne9BCZybSL4KhWC21BV8GWKgZ4fGq0JhCUi6CEeAZriec3jEuwfMarmyxodWAzVFkSZHd7S27JS4rkZvQC7IPgoIPJ5rQpNksxeFEtVi1rejMkrgqhhOMGCsGQenIrR7ezBgnlmlrODKL3JuWvfjYMfxwP72nFtL70uAAi-g8uSQS-BBJ4eC91KM3p5V8H7Ca6SSa5iw72q4_DY5z7VqymjdacLDogQC5-HhwOQ2yvqyFAOHA',
  adminProfile:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuChLaXegGAQXrv9CO8ekJRfhFoAyKQxMNRovzFlyr7qgm_bOx_ilJrsayjnFvyK47pmHPcJEQbrk0I8ZT5pG2JeKSi1kTug5vOwPY5N9iflecuPBGX2YlpyEi29EKK25SxEChOg9lXBpOL8DzoOnvwMM6IyiNfG-UstB6xGjTkD-WILfQ7bAplx8GLWB_iPU65wu3yPQhyboioTo_GUBjLU6npOvqzpWK5rutzRmVhd5nLS5upvwvgjyQ',
};

export const INITIAL_SERVERS: ServerInstance[] = [
  {
    id: 'mio-smp',
    name: "Mio's Survival & SMP",
    engine: 'PaperMC 1.20.4',
    javaVersion: 'Java 21',
    port: 25565,
    pid: 10484,
    status: 'running',
    path: 'C:\\KingServers\\MioSMP',
    build: 'Build #448',
    tps: 20.0,
    tickMs: 4.8,
    uptime: '14h 22m',
    playersOnline: 8,
    maxPlayers: 20,
    cpuUsage: 22,
    cpuTemp: 48.2,
    ramUsedGb: 4.2,
    ramMaxGb: 8.0,
    installedVersion: '1.20.4',
    latestVersion: '1.21.4',
    isOutdated: true,
    latestBuild: 'Build #222',
  },
  {
    id: 'aki-create',
    name: "Aki's Create & Tech Lab",
    engine: 'Fabric 1.20.1',
    javaVersion: 'Java 21',
    port: 25566,
    pid: 14920,
    status: 'running',
    path: 'C:\\KingServers\\AkiCreate',
    build: 'Loader 0.15.7',
    tps: 19.9,
    tickMs: 6.2,
    uptime: '42h 10m',
    playersOnline: 4,
    maxPlayers: 16,
    cpuUsage: 31,
    cpuTemp: 52.4,
    ramUsedGb: 6.4,
    ramMaxGb: 12.0,
    installedVersion: '1.20.1',
    latestVersion: '1.21.4',
    isOutdated: true,
    latestBuild: 'Loader 0.16.10',
  },
];

export const INITIAL_CONSOLE_LOGS: ConsoleLogLine[] = [
  {
    id: 'c1',
    time: '14:32:01',
    level: 'INFO',
    text: 'Starting minecraft server version 1.20.4 (PaperMC build #448)',
  },
  {
    id: 'c2',
    time: '14:32:02',
    level: 'INFO',
    text: 'Loading properties from server.properties...',
  },
  {
    id: 'c3',
    time: '14:32:03',
    level: 'UPnP',
    text: 'Mapped external port 25565 \u2192 internal 25565 (NAT-PMP protocol verified)',
  },
  {
    id: 'c4',
    time: '14:32:04',
    level: 'WARN',
    text: 'Chunk cache loaded in asynchronous mode; tick alignment at 20.0 TPS ensured',
    highlightBox: 'warn',
  },
  {
    id: 'c5',
    time: '14:32:06',
    level: 'INFO',
    text: '[LuckPerms] Loading permissions database (SQLite driver) OK.',
  },
  {
    id: 'c6',
    time: '14:32:08',
    level: 'INFO',
    text: 'Preparing start region for dimension minecraft:overworld',
  },
  {
    id: 'c7',
    time: '14:32:10',
    level: 'INFO',
    text: 'Done (8.432s)! For help, type "help" or "/?"',
  },
  {
    id: 'c8',
    time: '14:33:14',
    level: 'JOIN',
    text: 'Mio_Celestial [UUID: 8bf1a0...] logged in with entity id 104 at ([world] 24.5, 71.0, -118.2)',
    highlightBox: 'join',
  },
  {
    id: 'c9',
    time: '14:35:22',
    level: 'JOIN',
    text: 'Aki_Redstone [UUID: 1f0e42...] logged in with entity id 109 at ([world] 31.0, 70.0, -110.0)',
    highlightBox: 'join',
  },
  {
    id: 'c10',
    time: '14:40:02',
    level: 'ERROR',
    text: 'PacketFilter: Invalid keep-alive response from remote socket 198.51.100.44:59218 (Dropping connection)',
    highlightBox: 'error',
  },
  {
    id: 'c11',
    time: '14:42:15',
    level: 'JOIN',
    text: 'KuroBlocker logged in with entity id 115',
    highlightBox: 'join',
  },
  {
    id: 'c12',
    time: '14:44:01',
    level: 'INFO',
    text: '[AutoSave] Flushed 1,280 chunk sectors to region files in 14.1ms',
  },
  {
    id: 'c13',
    time: '14:48:33',
    level: 'CHAT',
    sender: 'Mio_Celestial',
    text: 'Everyone ready for the dragon respawn event tonight?',
  },
  {
    id: 'c14',
    time: '14:48:42',
    level: 'CHAT',
    sender: 'Aki_Redstone',
    text: 'Potions and bows stocked at spawn vault!',
  },
];

export const INITIAL_PLAYERS: ConnectedPlayer[] = [
  {
    id: 'p1',
    username: 'Mio_Celestial',
    initials: 'MC',
    colorClass: 'bg-amber-500 text-black',
    role: 'Owner',
    dimension: 'Survival_Spawn',
    ping: 12,
    uuid: '8bf1a042-32b4-4ef8-82c1-59c730e719c2',
    avatarUrl: HOTLINKED_IMAGES.avatarMio,
    online: true,
  },
  {
    id: 'p2',
    username: 'Aki_Redstone',
    initials: 'AK',
    colorClass: 'bg-sky-500 text-white',
    role: 'Admin',
    dimension: 'Nether_Fortress',
    ping: 19,
    uuid: '1f0e42d7-98e3-4fa2-bc11-44028199a01b',
    avatarUrl: HOTLINKED_IMAGES.avatarAki,
    online: true,
  },
  {
    id: 'p3',
    username: 'KuroBlocker',
    initials: 'KB',
    colorClass: 'bg-emerald-500 text-black',
    role: 'Moderator',
    dimension: 'End_Highlands',
    ping: 28,
    uuid: 'd7c19ba8-6f11-44bb-9a81-1182049f12c9',
    avatarUrl: HOTLINKED_IMAGES.avatarKuro,
    online: true,
  },
  {
    id: 'p4',
    username: 'VoxelRider_99',
    initials: 'VR',
    colorClass: 'bg-purple-500 text-white',
    role: 'Member',
    dimension: 'Survival_Spawn',
    ping: 34,
    uuid: '4e9a1172-ba00-47cb-aa19-83910421b00f',
    avatarUrl: HOTLINKED_IMAGES.avatarVoxel,
    online: true,
  },
];

export const INITIAL_FILES: FileItem[] = [
  {
    id: 'f-server-props',
    name: 'server.properties',
    path: 'C:\\KingServers\\MioSMP\\server.properties',
    type: 'file',
    size: '1.4 KB',
    permissions: 'rw-r--r--',
    icon: 'settings',
    iconColor: 'text-primary',
    language: 'properties',
    content: `# Minecraft server properties (PaperMC 1.20.4)
# Managed by IS King Panel FastPipe Engine v4.8
enable-jmx-monitoring=false
rcon.port=25575
level-seed=-84129481928491
gamemode=survival
enable-command-block=true
enable-query=false
generator-settings={}
enforce-secure-profile=true
level-name=world
motd=\\u2694\\uFE0F \\u00A76\\u00A7lKING SMP \\u00A78\\u00BB \\u00A7fWelcome to Season 4 \\u00A77[Custom Enchants]\\n\\u00A7a\\u2714 Zero Lag \\u00A77| \\u00A7ePaperMC 1.20.4 \\u00A77| \\u00A7bplay.kingsmp.net
query.port=25565
pvp=true
generate-structures=true
max-chained-neighbor-updates=1000000
difficulty=hard
network-compression-threshold=256
max-tick-time=60000
require-resource-pack=false
max-players=20
use-native-transport=true
online-mode=true
enable-status=true
allow-flight=true
initial-disabled-packs=
broadcast-rcon-to-ops=true
view-distance=10
server-ip=0.0.0.0
resource-pack-prompt=
allow-nether=true
server-port=25565
enable-rcon=false
sync-chunk-writes=true
op-permission-level=4
prevent-proxy-connections=false
hide-online-players=false
resource-pack=https://assets.kingsmp.net/packs/season4-v1.zip
entity-broadcast-range-percentage=100
simulation-distance=6
rcon.password=
player-idle-timeout=0
force-gamemode=false
rate-limit=0
hardcore=false
white-list=true
broadcast-console-to-ops=true
spawn-protection=16
resource-pack-sha1=a4c28f1109dc0e8f2a1b94
max-world-size=29999984`,
  },
  {
    id: 'f-bukkit',
    name: 'bukkit.yml',
    path: 'C:\\KingServers\\MioSMP\\bukkit.yml',
    type: 'file',
    size: '3.8 KB',
    icon: 'code',
    iconColor: 'text-tertiary',
    language: 'yaml',
    content: `# This is the main configuration file for Bukkit.
settings:
  allow-end: true
  warn-on-overload: true
  permissions-file: permissions.yml
  update-folder: update
  plugin-profiling: false
  connection-throttle: 4000
  query-plugins: true
  deprecated-verbose: default
  shutdown-message: Server is restarting via IS King Panel...
  minimum-api: none
spawn-limits:
  monsters: 70
  animals: 10
  water-animals: 5
  water-ambient: 20
  water-underground-creature: 5
  axolotls: 5
  ambient: 15
chunk-gc:
  period-in-ticks: 600
ticks-per:
  animal-spawns: 400
  monster-spawns: 1
  water-spawns: 1
  water-ambient-spawns: 1
  water-underground-creature-spawns: 1
  axolotl-spawns: 1
  ambient-spawns: 1
  autosave: 6000`,
  },
  {
    id: 'f-spigot',
    name: 'spigot.yml',
    path: 'C:\\KingServers\\MioSMP\\spigot.yml',
    type: 'file',
    size: '4.2 KB',
    icon: 'code',
    iconColor: 'text-tertiary',
    language: 'yaml',
    content: `# This is the main configuration file for Spigot.
config-version: 12
settings:
  debug: false
  bungeecord: true
  sample-count: 12
  player-shuffle: 0
  user-cache-size: 1000
  save-user-cache-on-stop-only: false
  moved-wrongly-threshold: 0.0625
  moved-too-quickly-multiplier: 10.0
  timeout-time: 60
  restart-on-crash: true
  restart-script: ./start.bat
  netty-threads: 4
world-settings:
  default:
    below-zero-generation-in-existing-chunks: true
    merge-radius:
      item: 2.5
      exp: 3.0
    view-distance: default
    simulation-distance: default
    mob-spawn-range: 8
    entity-activation-range:
      animals: 32
      monsters: 32
      raiders: 48
      misc: 16`,
  },
  {
    id: 'f-paper-world',
    name: 'paper-world-defaults.yml',
    path: 'C:\\KingServers\\MioSMP\\paper-world-defaults.yml',
    type: 'file',
    size: '18.2 KB',
    icon: 'code',
    iconColor: 'text-tertiary',
    language: 'yaml',
    content: `# PaperMC World Defaults Configuration (1.20.4)
_version: 31
anticheat:
  anti-xray:
    enabled: true
    engine-mode: 2
    hidden-blocks:
      - chest
      - coal_ore
      - deepslate_coal_ore
      - copper_ore
      - deepslate_copper_ore
      - raw_copper_block
      - diamond_ore
      - deepslate_diamond_ore
      - emerald_ore
      - deepslate_emerald_ore
      - gold_ore
      - deepslate_gold_ore
      - iron_ore
      - deepslate_iron_ore
    lava-obscures: false
    max-block-height: 64
    update-radius: 2
    use-permission: false
chunks:
  auto-save-interval: 6000
  delay-chunk-unloads-by: 10s
  entity-per-chunk-save-limit:
    arrow: 16
    ender_pearl: 16
    experience_orb: 16
    fireball: 8
    small_fireball: 8
    snowball: 16
  max-auto-save-chunks-per-tick: 8
  prevent-moving-into-unloaded-chunks: true`,
  },
  {
    id: 'dir-plugins',
    name: 'plugins',
    path: 'C:\\KingServers\\MioSMP\\plugins',
    type: 'folder',
    size: 'dir',
    badge: '7 packages',
    icon: 'folder_open',
    iconColor: 'text-primary',
    children: [
      {
        id: 'dir-essentials',
        name: 'EssentialsX',
        path: 'C:\\KingServers\\MioSMP\\plugins\\EssentialsX',
        type: 'folder',
        icon: 'folder_open',
        iconColor: 'text-primary',
        children: [
          {
            id: 'f-essentials-config',
            name: 'config.yml',
            path: 'C:\\KingServers\\MioSMP\\plugins\\EssentialsX\\config.yml',
            type: 'file',
            size: '28.4 KB',
            icon: 'description',
            iconColor: 'text-primary',
            language: 'yaml',
            content: `# EssentialsX Main Configuration (Engine: Paper 1.20.4)
# King Panel FastPipe Auto-Managed Configuration Snapshot
# See documentation at https://essentialsx.net/wiki/Configuration.html
ops-name-color: '4'
nickname-prefix: '~'
max-nick-length: 16

teleport-cooldown: 3
teleport-delay: 0
heal-cooldown: 60
near-radius: 200

spawn-listeners:
  respawn-at-home: true
  respawn-at-bed: true
  respawn-at-anchor: true

economy:
  starting-balance: 500.00
  currency-symbol: '$'
  max-money: 10000000000.00
  min-money: -10000.00

chat:
  radius: 0
  format: '<{DISPLAYNAME}> {MESSAGE}'

# End of EssentialsX segment block`,
          },
          {
            id: 'f-essentials-items',
            name: 'items.csv',
            path: 'C:\\KingServers\\MioSMP\\plugins\\EssentialsX\\items.csv',
            type: 'file',
            size: '64.2 KB',
            icon: 'table_chart',
            iconColor: 'text-secondary',
            language: 'csv',
            content: `# EssentialsX Item Alias Database (1.20.4)
# itemname,minecraft_material,data
diamondpick,diamond_pickaxe,0
netheritepick,netherite_pickaxe,0
gapple,golden_apple,0
egapple,enchanted_golden_apple,0
elytra,elytra,0
shulker,shulker_box,0
totem,totem_of_undying,0
beacon,beacon,0
enderpearl,ender_pearl,0
 blaze_rod,blaze_rod,0`,
          },
          {
            id: 'f-essentials-motd',
            name: 'motd.txt',
            path: 'C:\\KingServers\\MioSMP\\plugins\\EssentialsX\\motd.txt',
            type: 'file',
            size: '1.2 KB',
            icon: 'article',
            iconColor: 'text-on-surface-variant',
            language: 'text',
            content: `&6&l=============================================
&fWelcome back, &e{PLAYER}&f to &6&lMio's Survival & SMP&f!
&7Online Players: &a{ONLINE}&7/&a{MAXPLAYERS} &8| &7World Time: &b{WORLDTIME12}
&7Your Balance: &a{BALANCE} &8| &7Unread Mail: &e{MAILS}
&7Type &6/spawn &7to visit the market or &6/discord &7for voice chat!
&6&l=============================================`,
          },
        ],
      },
      {
        id: 'dir-luckperms',
        name: 'LuckPerms',
        path: 'C:\\KingServers\\MioSMP\\plugins\\LuckPerms',
        type: 'folder',
        permissions: 'drwxr-xr-x',
        icon: 'folder',
        iconColor: 'text-on-surface-variant',
      },
      {
        id: 'dir-vault',
        name: 'Vault',
        path: 'C:\\KingServers\\MioSMP\\plugins\\Vault',
        type: 'folder',
        permissions: 'drwxr-xr-x',
        icon: 'folder',
        iconColor: 'text-on-surface-variant',
      },
      {
        id: 'dir-worldedit',
        name: 'WorldEdit',
        path: 'C:\\KingServers\\MioSMP\\plugins\\WorldEdit',
        type: 'folder',
        permissions: 'drwxr-xr-x',
        icon: 'folder',
        iconColor: 'text-on-surface-variant',
      },
      {
        id: 'dir-coreprotect',
        name: 'CoreProtect',
        path: 'C:\\KingServers\\MioSMP\\plugins\\CoreProtect',
        type: 'folder',
        permissions: 'drwxr-xr-x',
        icon: 'folder',
        iconColor: 'text-on-surface-variant',
      },
    ],
  },
  {
    id: 'dir-world',
    name: 'world',
    path: 'C:\\KingServers\\MioSMP\\world',
    type: 'folder',
    size: '3.1 GB',
    icon: 'public',
    iconColor: 'text-primary-gold',
  },
  {
    id: 'dir-nether',
    name: 'world_nether',
    path: 'C:\\KingServers\\MioSMP\\world_nether',
    type: 'folder',
    size: '840 MB',
    icon: 'local_fire_department',
    iconColor: 'text-error',
  },
  {
    id: 'dir-logs',
    name: 'logs',
    path: 'C:\\KingServers\\MioSMP\\logs',
    type: 'folder',
    size: '12 files',
    icon: 'folder',
    iconColor: 'text-on-surface-variant',
  },
];

export const INITIAL_PLUGINS: PluginItem[] = [
  {
    id: 'luckperms',
    code: 'LP',
    codeColor: 'bg-primary/10 text-primary',
    name: 'LuckPerms',
    author: 'Luck',
    category: 'Permissions Engine',
    filterCategory: 'Administration & Permissions',
    source: 'Modrinth',
    description:
      'Industry-standard permissions management system for Minecraft servers. High performance, web-editor, and MariaDB/SQLite backend support.',
    rating: '4.9 (3.2k)',
    downloads: '4.2M dl',
    version: 'v5.4.102',
    targetVersion: 'v5.4.104',
    status: 'update_ready',
    extraTag: 'Paper 1.20.4',
    footerLeft: 'Web Editor',
  },
  {
    id: 'essentialsx',
    code: 'EX',
    codeColor: 'bg-orange-500/10 text-orange-400',
    name: 'EssentialsX',
    author: 'EssentialsX Team',
    category: 'Core Suite',
    filterCategory: 'Administration & Permissions',
    source: 'Paper Hangar',
    description:
      'The essential plugin suite including teleportation, spawn controls, kits, moderation, server signs, and Discord integration hooks.',
    rating: '4.8 (8.1k)',
    downloads: '4.1M dl',
    version: 'v2.20.1',
    targetVersion: 'v2.20.2',
    status: 'update_ready',
    extraTag: 'Paper Hangar',
    footerLeft: '6 Submodules Loaded',
  },
  {
    id: 'coreprotect',
    code: 'CP',
    codeColor: 'bg-secondary/10 text-secondary',
    name: 'CoreProtect',
    author: 'Intelli',
    category: 'Rollback & Audit',
    filterCategory: 'Security & Anti-Grief',
    source: 'SpigotMC',
    description:
      'Fast, efficient, and data-rich block logging, chest inspection, and grief-recovery rollback engine. Connected to local high-throughput SQLite.',
    rating: '4.9 (4.9k)',
    downloads: '2.8M dl',
    version: 'v22.2 Installed',
    targetVersion: 'v22.3',
    status: 'installed',
    extraTag: '2.4 GB DB File',
    footerLeft: 'Manage Database',
  },
  {
    id: 'spark',
    code: 'SP',
    codeColor: 'bg-tertiary/10 text-tertiary',
    name: 'Spark Profiler',
    author: 'lucko',
    category: 'Performance Telemetry',
    filterCategory: 'Optimization & Profiling',
    source: 'Modrinth',
    description:
      'CPU & memory telemetry profiler, tick loop breakdown, and garbage collection inspector directly integrated into the PaperMC runtime.',
    rating: '5.0 (1.8k)',
    downloads: '1.9M dl',
    version: 'v1.10.53',
    status: 'installed',
    extraTag: 'Zero Overhead',
    footerLeft: 'IPC Sampling Active',
  },
  {
    id: 'chunky',
    code: 'CK',
    codeColor: 'bg-surface-container text-white',
    name: 'Chunky',
    author: 'pop4959',
    category: 'Async World Generator',
    filterCategory: 'WorldGen & Chunk Engines',
    source: 'Modrinth',
    description:
      'Asynchronous chunk pre-generator that generates world regions ahead of player visits to eliminate chunk loading lag spikes.',
    rating: '4.9 (1.4k)',
    downloads: '890k dl',
    version: 'v1.3.92',
    status: 'installed',
    extraTag: 'Task: 10,000 r Complete',
    footerLeft: 'Radius Tasks',
  },
  {
    id: 'vault',
    code: 'VT',
    codeColor: 'bg-primary-gold/10 text-primary-gold',
    name: 'Vault API',
    author: 'MilkBowl',
    category: 'Economy Connector',
    filterCategory: 'Economy & RPG Systems',
    source: 'SpigotMC',
    description:
      'Core permissions, chat, and economy bridge interface linking server plugins together seamlessly.',
    rating: '4.8 (6.2k)',
    downloads: '6.1M dl',
    version: 'v1.7.3',
    status: 'installed',
    extraTag: '12 Hooks Active',
    footerLeft: 'Provider: EssentialsX Econ',
  },
  {
    id: 'worldedit',
    code: 'WE',
    codeColor: 'bg-surface-container text-white',
    name: 'WorldEdit',
    author: 'EngineHub',
    category: 'World Builder',
    filterCategory: 'WorldGen & Chunk Engines',
    source: 'CurseForge',
    description:
      'In-game Minecraft map editor. Selection brushes, schematic loaders, block palette replacements, and terrain shaping.',
    rating: '4.9 (5.1k)',
    downloads: '5.4M dl',
    version: 'v7.3.0',
    status: 'installed',
    extraTag: 'FAWE Compatible',
    footerLeft: 'Schematics Directory',
  },
  {
    id: 'geyser',
    code: 'GY',
    codeColor: 'bg-tertiary/20 text-tertiary',
    name: 'GeyserMC + Floodgate',
    author: 'GeyserMC',
    category: 'Bedrock Protocol Bridge',
    filterCategory: 'Developer APIs & Libs',
    source: 'Modrinth',
    description:
      'Enable Minecraft: Bedrock Edition players (iOS, Android, Xbox, Switch, PS5) to join your Paper Java server without account barriers.',
    rating: '5.0 (2.4k)',
    downloads: '1.2M dl',
    version: 'v2.2.0',
    status: 'available',
    extraTag: 'Crossplay UDP: 19132',
    footerLeft: 'Includes Floodgate auth',
  },
  {
    id: 'bluemap',
    code: 'BM',
    codeColor: 'bg-secondary/15 text-secondary',
    name: 'BlueMap 3D Web Visualizer',
    author: 'BlueColored',
    category: 'Community Choice',
    filterCategory: 'WorldGen & Chunk Engines',
    source: 'Paper Hangar',
    description:
      'Photorealistic 3D map renderer rendered directly with WebGL in browser. Zero lag background tile generation with multi-core support.',
    rating: '4.9 (980)',
    downloads: '620k dl',
    version: 'v3.18-paper',
    status: 'available',
    extraTag: 'Port :8100 Binding Ready',
    footerLeft: 'WebGL Live Tile Engine',
    fullWidth: true,
  },
];

export const INITIAL_PORTS: PortRule[] = [
  {
    port: 25565,
    proto: 'TCP/UDP',
    serviceName: 'PaperMC Game Kernel',
    badge: 'Primary',
    badgeColor: 'bg-secondary/15 text-secondary',
    target: '127.0.0.1:25565 • FastPipe',
    bindingType: 'UPnP + WinFirewall',
    bindingColor: 'text-secondary',
    bindingIcon: 'sync',
    throughput: '↓ 4.8 MB/s · ↑ 12.4 MB/s',
    activeLoad: '14 Active Players',
    loadColor: 'text-secondary',
    status: 'OPEN',
    statusNote: '(22ms Node)',
    category: 'game',
  },
  {
    port: 19132,
    proto: 'UDP',
    serviceName: 'GeyserMC Bedrock Bridge',
    target: 'Floodgate 2.0 Auth Protocol',
    bindingType: 'UPnP Auto-Lease',
    bindingColor: 'text-tertiary',
    bindingIcon: 'router',
    throughput: '↓ 420 KB/s · ↑ 890 KB/s',
    activeLoad: '3 Bedrock Peers',
    loadColor: 'text-tertiary',
    status: 'OPEN',
    statusNote: '(RakNet)',
    category: 'game',
  },
  {
    port: 8100,
    proto: 'TCP',
    serviceName: 'BlueMap 3D Web Visualizer',
    badge: 'HTTPS',
    badgeColor: 'bg-tertiary/20 text-tertiary',
    target: 'https://map.kingsmp.net',
    bindingType: 'Cloudflare Tunnel + UPnP',
    bindingColor: 'text-primary',
    bindingIcon: 'cloud',
    throughput: '↓ 1.1 MB/s · ↑ 4.2 MB/s',
    activeLoad: '5 Web Viewers',
    loadColor: 'text-outline',
    status: 'SSL SECURE',
    category: 'http',
  },
  {
    port: 25575,
    proto: 'TCP',
    serviceName: 'RCON Admin Remote Socket',
    badge: 'Private',
    badgeColor: 'bg-surface-bright text-outline',
    target: 'White-listed: 192.168.1.0/24',
    bindingType: 'LAN Restricted Only',
    bindingColor: 'text-outline',
    bindingIcon: 'shield',
    throughput: '↓ 12 KB/s · ↑ 18 KB/s',
    activeLoad: 'Panel IPC Daemon',
    loadColor: 'text-outline',
    status: 'NO WAN',
    statusNote: '[SAFE]',
    category: 'internal',
  },
  {
    port: 24454,
    proto: 'UDP',
    serviceName: 'Simple Voice Chat Plugin',
    target: 'Opus Spatial Audio Engine',
    bindingType: 'UPnP Auto-Lease',
    bindingColor: 'text-secondary',
    bindingIcon: 'sync',
    throughput: '↓ 1.2 MB/s · ↑ 2.8 MB/s',
    activeLoad: '11 Talking Channels',
    loadColor: 'text-secondary',
    status: 'OPEN',
    statusNote: '(Low Jitter)',
    category: 'game',
  },
];

export const INITIAL_SNAPSHOTS: SnapshotItem[] = [
  {
    id: 'snap-1',
    title: 'Automated Daily Midnight Backup',
    badge: 'Latest Point',
    badgeType: 'primary',
    verified: true,
    pinned: false,
    timestamp: 'Today at 04:00 AM UTC (4h ago)',
    size: '2.1 GB',
    note: '(zstd compressed from 5.8 GB)',
    scopes: ['World', 'Nether', 'End', 'Plugins (44)', 'SQLite DBs'],
    destination: 'NVMe FastPipe',
    cloudDest: 'AWS S3 (eu-central-1)',
    sha: 'SHA: 8f9b...a10e',
    icon: 'auto_mode',
    iconColor: 'bg-primary/10 text-primary',
  },
  {
    id: 'snap-2',
    title: 'Pre-Plugin Update Snapshot',
    badge: 'Hot-Rollback Safe',
    badgeType: 'tertiary',
    verified: false,
    pinned: false,
    timestamp: 'Yesterday at 18:24 UTC',
    size: '2.05 GB',
    note: '(Created before EssentialsX & LuckPerms bump)',
    scopes: ['/plugins/', '/config/', 'paper-global.yml'],
    destination: 'Local NVMe Only',
    icon: 'extension',
    iconColor: 'bg-tertiary/10 text-tertiary',
  },
  {
    id: 'snap-3',
    title: 'Scheduled Weekly Full Archive',
    badge: 'Pinned Long-Term',
    badgeType: 'gold',
    verified: true,
    pinned: true,
    timestamp: '3 days ago (Sunday 00:00)',
    size: '2.4 GB',
    note: '(Retention Exemption Enabled)',
    scopes: ['Full Server', 'PlayerData', 'CoreProtect Logs (7.4M rows)'],
    destination: 'AWS S3 + Google Drive',
    icon: 'inventory_2',
    iconColor: 'bg-primary-gold/10 text-primary-gold',
  },
  {
    id: 'snap-4',
    title: "Manual: 'Before Dragon Fight Event'",
    badge: 'Manual Checkpoint',
    badgeType: 'neutral',
    verified: false,
    pinned: false,
    timestamp: '5 days ago by Admin [Mio]',
    size: '2.1 GB',
    scopes: ['The End Dimension & World Chunk Cache'],
    destination: 'Local NVMe High-Speed',
    icon: 'bookmark',
    iconColor: 'bg-secondary/10 text-secondary',
  },
];

export const INITIAL_CRONS: CronTask[] = [
  {
    id: 'cron-1',
    title: 'Hourly World Flush & GC',
    cron: '0 * * * *',
    status: 'Active',
    description:
      'Invokes PaperMC `/save-all flush` followed by an asynchronous Java G1GC memory collection sweep.',
    nextRun: 'Next run in: 34 mins',
    actionLabel: 'Run Now',
    icon: 'save',
    iconColor: 'bg-secondary/10 text-secondary',
  },
  {
    id: 'cron-2',
    title: 'Nightly ZSTD Snapshot',
    cron: '0 4 * * *',
    status: 'Active',
    description:
      'Full safe snapshot with zero-pause world freeze, uploaded to AWS S3 & synced to Google Drive mirror.',
    nextRun: 'Next run in: 20 hours (04:00 UTC)',
    actionLabel: 'Run Now',
    icon: 'nightlight',
    iconColor: 'bg-primary/10 text-primary',
  },
  {
    id: 'cron-3',
    title: 'Scheduled Daily Restart',
    cron: '0 6 * * *',
    status: 'Active',
    description:
      'Broadcasts in-game countdown alerts at 15m, 5m, and 60s via `/say` and Discord webhook before restarting server cleanly.',
    nextRun: 'Next run in: 22 hours (06:00 UTC)',
    actionLabel: 'Dry Run',
    icon: 'restart_alt',
    iconColor: 'bg-tertiary/10 text-tertiary',
  },
  {
    id: 'cron-4',
    title: 'CoreProtect SQLite Vacuum',
    cron: '0 2 * * 0',
    status: 'Weekly',
    description:
      'Purges block transaction logs older than 30 days and executes an asynchronous database VACUUM to reclaim storage.',
    nextRun: 'Runs every Sunday at 02:00',
    actionLabel: 'Re-index',
    icon: 'cleaning_services',
    iconColor: 'bg-primary-gold/10 text-primary-gold',
  },
];

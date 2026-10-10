# IS King Panel

A Windows desktop application for managing Minecraft servers, built with Electron, React, and Vite.

## Features

- Server management (start, stop, restart)
- Modpack and plugin installation via Modrinth
- OAuth authentication (Discord, GitHub, Google)
- SQLite3 database for local storage
- Real-time telemetry (CPU, RAM, network)
- Port forwarding and network tools
- Cross-platform (Windows 10/11)

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- Git

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/kingplayz1/KingPanel.git
   cd KingPanel-
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables (copy `.env.example` to `.env` and fill in your keys):
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

4. Run the application:
   ```bash
   npm run dev
   ```

### Building for Windows

To create a standalone Windows executable:

```bash
# Set your GitHub token for publishing (optional)
set GH_TOKEN=your_github_token

# Build and publish to GitHub Releases (enables auto-update)
npm run electron:build:win -- --publish=always
```

The installer will be available in `dist_electron/` as `IS King Panel Setup x64.exe`.

## Auto-Update

The application is configured to automatically check for updates on GitHub Releases. When a new version is published, users will be prompted to update.

## License

This project is private and proprietary.

## Contact

For support or inquiries, please open an issue on GitHub.

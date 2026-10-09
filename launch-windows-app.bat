@echo off
title IS King Panel v4.8 — Windows Desktop App Launcher
color 0E
echo ============================================================================
echo   IS KING PANEL v4.8 — WINDOWS 11 LOCALHOST SERVER WORKSTATION (.EXE MODE)
echo   Super Admin ID: kingplayz (SA-KINGPLAYZ-001) ^| Pass: KingPlayz#2026
echo   SQLite3 WAL Database: .\database\isking_panel.sqlite
echo ============================================================================
echo.
echo [1/2] Starting Localhost Node + SQLite3 + PaperMC Background Daemon...
start /B cmd /c "npm run dev"
timeout /t 3 /nobreak >nul
echo [2/2] Launching Native Frameless Windows App Window...
start "" msedge --app=http://127.0.0.1:3000 --window-size=1520,940
exit

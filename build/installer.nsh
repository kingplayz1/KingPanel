; Custom NSIS hooks for IS King Panel.
;
; Builds before 1.0.1 wrote servers to <install dir>\KingServers, because the
; packaged backend used its working directory as the server root. A Windows
; update replaces (or atomically moves away) the whole installation directory,
; so the previous version's uninstaller destroys those worlds before the new
; version can run. verified: the 1.0.0 -> 1.0.1 update deleted a seeded folder
; from the install dir (scripts/verify-installed-upgrade.mjs --legacy-data).
;
; customInit runs in .onInit of the new installer, which is before the install
; section invokes uninstallOldVersion, so this is the last moment the old data
; is still on disk. Copy it next to userData, where the app imports it on first
; launch (importLegacyInstallData in server.ts).

!macro customInit
  ${if} ${FileExists} "$INSTDIR\KingServers\*.*"
    # Electron always keeps user data in the per-user AppData folder, even for a
    # per-machine install, so read $APPDATA in the current-user context.
    SetShellVarContext current
    StrCpy $R8 "$APPDATA\${APP_PACKAGE_NAME}\legacy-install-servers"
    CreateDirectory "$R8"

    DetailPrint "Preserving server data from the previous installation..."
    nsExec::ExecToLog 'robocopy "$INSTDIR\KingServers" "$R8" /E /NFL /NDL /NJH /NJS /R:1 /W:1'
    Pop $R9

    # Losing the copy silently would be the same bug with extra steps: stop and
    # tell the user where their worlds are instead of updating over them.
    ${ifNot} ${FileExists} "$R8\*.*"
      MessageBox MB_ICONSTOP|MB_OK "IS King Panel could not move your server data out of the installation folder.$\r$\n$\r$\nNothing has been changed. Copy $INSTDIR\KingServers to a safe folder, then run the installer again."
      Abort
    ${endif}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend

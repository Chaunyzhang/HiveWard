; UUID.v5(local.opc.app, electron-builder namespace)，只清理同目录的 HiveWard 旧安装登记。
!define HIVEWARD_LEGACY_GUID "2c9c3646-e621-507d-9f90-0e1a5fa6e28b"
!define HIVEWARD_LEGACY_UNINSTALL "Software\Microsoft\Windows\CurrentVersion\Uninstall\${HIVEWARD_LEGACY_GUID}"
!define HIVEWARD_LEGACY_BACKUP "Software\HiveWard\Migration\${HIVEWARD_LEGACY_GUID}"

!macro HIVEWARD_MIGRATE_INSTALL_REGISTRATION
  Push $0
  Push $1
  Push $2
  ReadRegStr $0 SHELL_CONTEXT "Software\${HIVEWARD_LEGACY_GUID}" "InstallLocation"
  ReadRegStr $1 SHELL_CONTEXT "${HIVEWARD_LEGACY_UNINSTALL}" "DisplayName"
  ReadRegStr $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayName"
  ${if} $0 == "$INSTDIR"
  ${andIf} $1 == "HiveWard"
  ${andIf} $2 == "HiveWard"
    ReadRegStr $2 SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "InstallLocation"
    ${if} $2 == ""
      WriteRegStr SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "InstallLocation" "$0"
      WriteRegStr SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "DisplayName" "$1"
      ReadRegStr $2 SHELL_CONTEXT "${HIVEWARD_LEGACY_UNINSTALL}" "UninstallString"
      WriteRegStr SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "UninstallString" "$2"
      ReadRegStr $2 SHELL_CONTEXT "${HIVEWARD_LEGACY_UNINSTALL}" "DisplayVersion"
      WriteRegStr SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "DisplayVersion" "$2"
    ${endIf}
    ClearErrors
    ReadRegStr $2 SHELL_CONTEXT "${HIVEWARD_LEGACY_BACKUP}" "InstallLocation"
    ${ifNot} ${Errors}
    ${andIf} $2 == "$INSTDIR"
      DeleteRegKey SHELL_CONTEXT "${HIVEWARD_LEGACY_UNINSTALL}"
    ${endIf}
  ${endIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

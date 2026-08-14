!define OCM_INSTALL_MARKER_FILE ".opencode-memory-install-root"
!define OCM_INSTALL_MARKER_VALUE "OpenCodeMemory.InstallRoot.v1"

!macro OcmEnsureDedicatedInstallDirectory
  ${StdUtils.GetFileNamePart} $R8 "$INSTDIR"
  ${If} $R8 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend

!macro OcmIsReparsePoint RESULT
  StrCpy ${RESULT} "0"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r8'
  ${If} $R8 != -1
    IntOp $R8 $R8 & 0x400
    ${If} $R8 != 0
      StrCpy ${RESULT} "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro OcmValidateInstallRoot RESULT SUFFIX
  StrCpy ${RESULT} "0"
  StrCmp "$INSTDIR" "" ocm_validate_done_${SUFFIX}

  ${StdUtils.GetFileNamePart} $R8 "$INSTDIR"
  StrCmp "$R8" "${APP_FILENAME}" 0 ocm_validate_done_${SUFFIX}
  !insertmacro OcmIsReparsePoint $R8
  StrCmp "$R8" "1" ocm_validate_done_${SUFFIX}
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 ocm_validate_done_${SUFFIX}
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 ocm_validate_done_${SUFFIX}
  IfFileExists "$INSTDIR\${OCM_INSTALL_MARKER_FILE}" 0 ocm_validate_done_${SUFFIX}

  ClearErrors
  FileOpen $R7 "$INSTDIR\${OCM_INSTALL_MARKER_FILE}" r
  IfErrors ocm_validate_done_${SUFFIX}
  FileRead $R7 $R4
  FileClose $R7
  StrLen $R5 "${OCM_INSTALL_MARKER_VALUE}"
  StrCpy $R6 "$R4" $R5
  StrCmp "$R6" "${OCM_INSTALL_MARKER_VALUE}" 0 ocm_validate_done_${SUFFIX}
  StrCpy $R6 "$R4" 1 $R5
  StrCmp "$R6" "" ocm_validate_marker_ok_${SUFFIX}
  StrCmp "$R6" "$\r" ocm_validate_marker_ok_${SUFFIX}
  StrCmp "$R6" "$\n" ocm_validate_marker_ok_${SUFFIX} ocm_validate_done_${SUFFIX}

  ocm_validate_marker_ok_${SUFFIX}:
  StrCpy ${RESULT} "1"

  ocm_validate_done_${SUFFIX}:
!macroend

!macro OcmValidateLegacyInstallRoot RESULT SUFFIX
  StrCpy ${RESULT} "0"
  ReadRegStr $R5 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp "$R5" "$INSTDIR" 0 ocm_legacy_done_${SUFFIX}
  ${StdUtils.GetFileNamePart} $R8 "$INSTDIR"
  StrCmp "$R8" "${APP_FILENAME}" 0 ocm_legacy_done_${SUFFIX}
  !insertmacro OcmIsReparsePoint $R8
  StrCmp "$R8" "1" ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\resources\app.asar" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\resources\runtime\node.exe" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\resources\plugin\opencode-mem.js" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\resources\service\dist\standalone\service-main.js" 0 ocm_legacy_done_${SUFFIX}
  IfFileExists "$INSTDIR\resources\service-wrapper\register-background-task.ps1" 0 ocm_legacy_done_${SUFFIX}
  StrCpy ${RESULT} "1"

  ocm_legacy_done_${SUFFIX}:
!macroend

!macro OcmDirectoryHasEntries RESULT SUFFIX
  StrCpy ${RESULT} "0"
  IfFileExists "$INSTDIR\*.*" 0 ocm_directory_done_${SUFFIX}
  FindFirst $R7 $R6 "$INSTDIR\*.*"
  ocm_directory_loop_${SUFFIX}:
    StrCmp $R6 "" ocm_directory_close_${SUFFIX}
    StrCmp $R6 "." ocm_directory_next_${SUFFIX}
    StrCmp $R6 ".." ocm_directory_next_${SUFFIX}
    StrCpy ${RESULT} "1"
    Goto ocm_directory_close_${SUFFIX}
  ocm_directory_next_${SUFFIX}:
    FindNext $R7 $R6
    Goto ocm_directory_loop_${SUFFIX}
  ocm_directory_close_${SUFFIX}:
    FindClose $R7
  ocm_directory_done_${SUFFIX}:
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro OcmEnsureDedicatedInstallDirectory

    !insertmacro OcmIsReparsePoint $R9
    ${If} $R9 == "1"
      MessageBox MB_OK|MB_ICONSTOP "OpenCode Memory cannot be installed into a junction or symbolic-link directory. Nothing was installed or removed." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}

    !insertmacro OcmValidateInstallRoot $R9 check_existing
    ${If} $R9 != "1"
      !insertmacro OcmValidateLegacyInstallRoot $R9 check_legacy
      ${If} $R9 == "1"
        nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /End /TN "OpenCodeMemoryService"'
        Pop $R8
        Sleep 800
        IfFileExists "$INSTDIR\resources\service-wrapper\stop-desktop-processes.ps1" 0 +3
          nsExec::ExecToLog '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-wrapper\stop-desktop-processes.ps1" -InstallDir "$INSTDIR"'
          Pop $R8
        Goto ocm_install_path_ready
      ${EndIf}

      !insertmacro OcmDirectoryHasEntries $R9 check_nonempty
      ${If} $R9 == "1"
        MessageBox MB_OK|MB_ICONSTOP "OpenCode Memory requires its own installation folder. The selected folder already contains files and is not a verified OpenCode Memory installation. Nothing was installed or removed." /SD IDOK
        SetErrorLevel 2
        Abort
      ${EndIf}
      Goto ocm_install_path_ready
    ${EndIf}
  !endif

  !insertmacro OcmValidateInstallRoot $R9 check_managed
  ${If} $R9 == "1"
    nsExec::ExecToLog '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-wrapper\remove-background-task.ps1" -InstallDir "$INSTDIR" -StopOnly'
    Pop $R9
    ${If} $R9 != 0
      MessageBox MB_OK|MB_ICONSTOP "OpenCode Memory could not safely stop its managed processes. No application files were removed." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}

  !ifndef BUILD_UNINSTALLER
    ocm_install_path_ready:
  !endif
!macroend

!macro customInstall
  !insertmacro OcmValidateInstallRoot $R9 install
  ${If} $R9 != "1"
    MessageBox MB_OK|MB_ICONSTOP "The OpenCode Memory installation directory failed its safety check. Background service registration was cancelled." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-wrapper\register-background-task.ps1" -InstallRoot "$INSTDIR\resources" -RestartRunning'
  Pop $R9
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "OpenCode Memory was installed, but its background task could not be registered." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  Delete "$INSTDIR\resources\service-wrapper\OpenCodeMemoryService.cmd"
!macroend

!macro customUnInit
  !insertmacro OcmValidateInstallRoot $R9 uninstall_init
  ${If} $R9 != "1"
    MessageBox MB_OK|MB_ICONSTOP "Uninstall was stopped because the selected directory is not a verified OpenCode Memory installation. No application files were removed." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\service-wrapper\remove-background-task.ps1" -InstallDir "$INSTDIR"'
  Pop $R9
  ${If} $R9 != 0
    MessageBox MB_OK|MB_ICONSTOP "OpenCode Memory could not safely remove its background integration. No application files were removed." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

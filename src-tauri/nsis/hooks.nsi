!macro NSIS_HOOK_POSTINSTALL
  ; Add install directory to user PATH
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable(\"Path\", [Environment]::GetEnvironmentVariable(\"Path\", \"User\") + \";$INSTDIR\", \"User\")"'
  ; Notify running applications of environment change
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove install directory from user PATH
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "$p = [Environment]::GetEnvironmentVariable(\"Path\", \"User\"); $p = ($p.Split(\";\") | Where-Object { $_ -ne \"$INSTDIR\" }) -join \";\"; [Environment]::SetEnvironmentVariable(\"Path\", $p, \"User\")"'
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

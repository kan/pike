; PATH 管理は User スコープの環境変数を PowerShell + .NET Registry API で操作する。
; 注意点（issue #146）:
;   - updater は installMode=passive のため、このフックは初回インストールだけでなく
;     セルフアップデートのたびに走る。冪等でないと $INSTDIR が毎回追記されて PATH が肥大化する。
;   - [Environment]::SetEnvironmentVariable(...,"User") は値を REG_SZ で書き込み、
;     User PATH 全体を REG_EXPAND_SZ から REG_SZ へ劣化させる（%SystemRoot% 等が固定化される）。
; 対策:
;   - 既存の $INSTDIR エントリ（末尾 \ 差異・大小無視。-ne は既定で case-insensitive）と空エントリを
;     除去してから 1 個だけ追加する（冪等化 + 既に肥大化した PATH の掃除）。
;   - GetValue に DoNotExpandEnvironmentNames を渡して %var% を展開せず生値のまま読み、
;     SetValue で RegistryValueKind.ExpandString（REG_EXPAND_SZ）として書き戻す。
; NSIS エスケープ: PowerShell 変数の $ は $$、二重引用符は \"、$INSTDIR のみ NSIS が展開する。

!macro NSIS_HOOK_POSTINSTALL
  ; Add install directory to user PATH (idempotent, REG_EXPAND_SZ preserved)
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(\"Environment\");$$cur=[string]$$k.GetValue(\"Path\",$$null,\"DoNotExpandEnvironmentNames\");$$t=\"$INSTDIR\";$$p=@($$cur.Split([char]59)|?{$$_.Length -gt 0 -and $$_.TrimEnd([char]92) -ne $$t.TrimEnd([char]92)});$$p+=$$t;[Microsoft.Win32.Registry]::SetValue(\"HKEY_CURRENT_USER\Environment\",\"Path\",($$p -join [char]59),[Microsoft.Win32.RegistryValueKind]::ExpandString)"'
  ; Notify running applications of environment change
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove all install-directory entries from user PATH (REG_EXPAND_SZ preserved)
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(\"Environment\");$$cur=[string]$$k.GetValue(\"Path\",$$null,\"DoNotExpandEnvironmentNames\");$$t=\"$INSTDIR\";$$p=@($$cur.Split([char]59)|?{$$_.Length -gt 0 -and $$_.TrimEnd([char]92) -ne $$t.TrimEnd([char]92)});[Microsoft.Win32.Registry]::SetValue(\"HKEY_CURRENT_USER\Environment\",\"Path\",($$p -join [char]59),[Microsoft.Win32.RegistryValueKind]::ExpandString)"'
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

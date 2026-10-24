# フォルダの中のフォントをマシンのフォントとして入れる（CI の撮影用、#506）。
#
#   pwsh scripts/install-fonts.ps1 <フォルダ>
#
# 対象は直下の *.ttf / *.ttc / *.otf。%WINDIR%\Fonts へ写してレジストリに載せ、
# 今のセッションにも見せる。GDI には AddFontResourceW で読み込ませ、WebView2 が使う
# DirectWrite のために FontCache サービスを作り直させる（効いたかは撮影の前提の検査で見る）。
param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Win32 -Name Font -MemberDefinition @'
[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern int AddFontResourceW(string file);
[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
'@

$fonts = Get-ChildItem -Path $Dir -File | Where-Object Extension -In '.ttf', '.ttc', '.otf'
if (-not $fonts) { throw "$Dir にフォントが無い" }
foreach ($f in $fonts) {
  $dest = Join-Path "$env:WINDIR\Fonts" $f.Name
  Copy-Item $f.FullName $dest -Force
  $kind = if ($f.Extension -eq '.otf') { 'OpenType' } else { 'TrueType' }
  New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts' `
    -Name "$($f.BaseName) ($kind)" -Value $f.Name -PropertyType String -Force | Out-Null
  [void][Win32.Font]::AddFontResourceW($dest)
  Write-Host "installed $($f.Name)"
}
# WM_FONTCHANGE を全ウィンドウへ
$r = [IntPtr]::Zero
[void][Win32.Font]::SendMessageTimeoutW([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$r)
Restart-Service FontCache -Force

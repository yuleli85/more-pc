# 只更新「连接程序」到最新版（不重装 Node、不动 WorkBuddy 命令行）
# 用法（PowerShell）：irm "<总控>/update.ps1?t=<口令>" | iex
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Hub = '__HUB_URL__'
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'

if (-not (Test-Path "$Dir\agent.js")) {
  Write-Host '这台还没接入总控：请用网页「加电脑」里的加入命令。' -ForegroundColor Yellow
  return
}
if (Test-Path "$Dir\config.json") {
  try {
    $cfg = Get-Content "$Dir\config.json" -Raw | ConvertFrom-Json
    if ($cfg.hub) { $Hub = $cfg.hub }
  } catch { }
}

Write-Host "从 $Hub 下载最新连接程序..."
$new = "$Dir\agent.js.new"
try { Invoke-WebRequest "$Hub/agent.js" -UseBasicParsing -OutFile $new } catch {
  Write-Host ('下载失败：' + $_.Exception.Message) -ForegroundColor Red
  return
}

$src = Get-Content $new -Raw
if ($src -notmatch "const VERSION = '([0-9][0-9.]*)'") {
  Write-Host '下载到的文件不像连接程序，已放弃（原文件没动）。' -ForegroundColor Red
  Remove-Item $new -Force -ErrorAction SilentlyContinue
  return
}
$newVer = $Matches[1]
$oldVer = ''
$old = Get-Content "$Dir\agent.js" -Raw
if ($old -match "const VERSION = '([0-9][0-9.]*)'") { $oldVer = $Matches[1] }

Copy-Item "$Dir\agent.js" "$Dir\agent.js.bak" -Force -ErrorAction SilentlyContinue
Move-Item $new "$Dir\agent.js" -Force

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*wb-fleet*agent.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
# 重新拉起来：优先用带保活的 loop-agent.cmd，其次 vbs，最后直接起 node
$started = $false
if (Test-Path "$Dir\loop-agent.cmd") {
  try { Start-Process cmd.exe -ArgumentList '/c', "`"$Dir\loop-agent.cmd`"" -WindowStyle Hidden | Out-Null; $started = $true } catch { }
}
if (-not $started -and (Test-Path "$Dir\start-agent.vbs")) {
  try { Start-Process wscript.exe -ArgumentList "`"$Dir\start-agent.vbs`"" -WindowStyle Hidden | Out-Null; $started = $true } catch { }
}
if (-not $started) {
  $nodeExe = 'node'
  if (Test-Path "$Dir\node\node.exe") { $nodeExe = "$Dir\node\node.exe" }
  try { Start-Process $nodeExe -ArgumentList @("`"$Dir\agent.js`"", '--config', "`"$Dir\config.json`"") -WindowStyle Hidden -WorkingDirectory $Dir | Out-Null; $started = $true } catch { }
}
if (-not $started) {
  Write-Host '文件已换成新版，但没能自动拉起来：请手动双击 start-agent.vbs（或重启这台机器）。' -ForegroundColor Yellow
  return
}

Write-Host "连接程序 $oldVer -> $newVer 已更新，正在重连总控（约 5 秒）。" -ForegroundColor Green
Write-Host '回总控网页刷新一下，那台电脑的版本号应该变了。'

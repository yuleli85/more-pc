# wb-fleet 连接程序升级脚本（总控下发版）
# 只做三件事：从总控下载新版 agent.js、备份旧文件、3 秒后重启连接程序进程
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Hub = '__HUB_URL__'
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'

if (-not (Test-Path "$Dir\agent.js")) {
  Write-Host '这台还没接入总控（找不到 .wb-fleet\agent.js），跳过。'
  return
}

$new = "$Dir\agent.js.new"
try { Invoke-WebRequest "$Hub/agent.js" -UseBasicParsing -OutFile $new } catch {
  Write-Host ('下载失败：' + $_.Exception.Message + '（原文件没动）')
  return
}

$src = Get-Content $new -Raw
if ($src -notmatch "const VERSION = '([0-9][0-9.]*)'") {
  Write-Host '下载到的内容不是连接程序，已放弃（原文件没动）。'
  Remove-Item $new -Force -ErrorAction SilentlyContinue
  return
}
$newVer = $Matches[1]
$oldVer = ''
if ((Get-Content "$Dir\agent.js" -Raw) -match "const VERSION = '([0-9][0-9.]*)'") { $oldVer = $Matches[1] }

Copy-Item "$Dir\agent.js" "$Dir\agent.js.bak" -Force -ErrorAction SilentlyContinue
Move-Item $new "$Dir\agent.js" -Force
Write-Host "已换成新版：$oldVer -> $newVer"

# 重启放到分离进程里做（3 秒后），免得打断正在回复的这次会话
$restart = @'
Start-Sleep -Seconds 3
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*wb-fleet*agent.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
if (Test-Path "$Dir\loop-agent.cmd") {
  Start-Process cmd.exe -ArgumentList '/c', "`"$Dir\loop-agent.cmd`"" -WindowStyle Hidden
} elseif (Test-Path "$Dir\start-agent.vbs") {
  Start-Process wscript.exe -ArgumentList "`"$Dir\start-agent.vbs`"" -WindowStyle Hidden
} elseif (Test-Path "$Dir\node\node.exe") {
  Start-Process "$Dir\node\node.exe" -ArgumentList "`"$Dir\agent.js`"", '--config', "`"$Dir\config.json`"" -WindowStyle Hidden -WorkingDirectory $Dir
} else {
  Start-Process node -ArgumentList "`"$Dir\agent.js`"", '--config', "`"$Dir\config.json`"" -WindowStyle Hidden -WorkingDirectory $Dir
}
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($restart))
Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64) -WindowStyle Hidden

Write-Host '连接程序会在 3 秒后自动重启：本机在总控网页上会短暂离线，随后自动回来。'

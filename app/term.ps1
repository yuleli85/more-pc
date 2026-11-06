# 装 WorkBuddy 总控的终端（Windows）：装好后在 PowerShell 或 cmd 里用 wb 命令向云主机派活、看各台状态、看结果。
# 用法（PowerShell）：irm "<总控>/term.ps1?t=<口令>" | iex   （总控网页「加电脑」里直接复制）
# 不用管理员权限；没有 Node 就装一份到 %USERPROFILE%\.wb-fleet。重跑就是升级或换总控。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Hub = '__HUB_URL__'
$Key = '__FLEET_KEY__'
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'
$NodeVer = 'v22.12.0'
New-Item -ItemType Directory -Force -Path $Dir, "$Dir\bin" | Out-Null
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }

$Node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and [int]((& node -p "process.versions.node.split('.')[0]") 2>$null) -ge 18) { $Node = $sys.Source }
elseif (Test-Path "$Dir\node\node.exe") { $Node = "$Dir\node\node.exe" }
else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  Say "装 Node（只放在 $Dir，不动系统）"
  $zip = "$Dir\node.zip"
  Invoke-WebRequest "https://npmmirror.com/mirrors/node/$NodeVer/node-$NodeVer-win-$arch.zip" -UseBasicParsing -OutFile $zip
  if (-not (Test-Path $zip)) { Write-Host 'Node 没下载下来，请检查网络后重跑这行命令' -ForegroundColor Red; return }
  Expand-Archive $zip -DestinationPath $Dir -Force
  if (Test-Path "$Dir\node") { Remove-Item "$Dir\node" -Recurse -Force }
  Rename-Item "$Dir\node-$NodeVer-win-$arch" 'node'
  Remove-Item $zip
  $Node = "$Dir\node\node.exe"
}

Invoke-WebRequest "$Hub/wb.js" -UseBasicParsing -OutFile "$Dir\wb.js"
$cfg = @{ hub = $Hub; key = $Key } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("$Dir\wb.json", $cfg, (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText("$Dir\bin\wb.cmd", "@`"$Node`" `"$Dir\wb.js`" %*`r`n", (New-Object Text.UTF8Encoding $false))

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq "$Dir\bin" })) {
  [Environment]::SetEnvironmentVariable('Path', ("$userPath;$Dir\bin").TrimStart(';'), 'User')
}
$env:Path = "$Dir\bin;$env:Path"

Say '终端装好了，先连一下总控：'
& "$Dir\bin\wb.cmd"
Write-Host ''
& "$Dir\bin\wb.cmd" help
Write-Host "`n以后在 PowerShell 或 cmd 里直接打 wb 就行（新开的窗口才认得）。" -ForegroundColor Yellow

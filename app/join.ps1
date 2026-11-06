# 把这台电脑接进 WorkBuddy 总控（Windows）。用法（PowerShell）：irm "<总控>/join.ps1?t=<口令>" | iex
# 想起名字先运行：$env:FLEET_NAME="名字"；默认文件夹：$env:FLEET_WORKDIR="D:\某文件夹"
# 做的事：没有 Node 就装一份到 %USERPROFILE%\.wb-fleet（不用管理员）→ 没有 WorkBuddy 命令行就装上 → 下载连接程序 → 登录后自动连。
# 不用 Stop：Windows PowerShell 5.1 里外部程序往错误输出写一行就会被当成致命错误，关键步骤后面自己检查
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Hub = '__HUB_URL__'
$Key = '__FLEET_KEY__'
$Name = if ($env:FLEET_NAME) { $env:FLEET_NAME } else { $env:COMPUTERNAME }
$WorkDir = if ($env:FLEET_WORKDIR) { $env:FLEET_WORKDIR } else { Join-Path $env:USERPROFILE 'WorkBuddy-tasks' }
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'
$NodeVer = 'v22.12.0'
$Reg = 'https://registry.npmmirror.com'
New-Item -ItemType Directory -Force -Path $Dir, $WorkDir | Out-Null
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# 1. Node 18+
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
$NodeDir = Split-Path $Node
$env:Path = "$NodeDir;$env:APPDATA\npm;$env:Path"

# 2. WorkBuddy 命令行（CodeBuddy Code，和 WorkBuddy 同一个内核、同一个账号）
# 要 .cmd 或 .exe，别拿到 npm 生成的 .ps1（cmd 里跑不了）
$Cb = @('codebuddy.cmd', 'codebuddy.exe') | ForEach-Object { (Get-Command $_ -ErrorAction SilentlyContinue).Source } | Select-Object -First 1
if (-not $Cb) {
  Say '装 WorkBuddy 命令行'
  & "$NodeDir\npm.cmd" i -g --prefix "$Dir\npm" '@tencent-ai/codebuddy-code' "--registry=$Reg" | Out-Null
  $Cb = "$Dir\npm\codebuddy.cmd"
  if (-not (Test-Path $Cb)) { Write-Host 'WorkBuddy 命令行没装上，请检查网络后重跑这行命令' -ForegroundColor Red; return }
}
$ver = (& $Cb --version) 2>$null
Say "WorkBuddy 命令行：$ver"

# 3. 连接程序
Invoke-WebRequest "$Hub/agent.js" -UseBasicParsing -OutFile "$Dir\agent.js"
if (-not (Test-Path "$Dir\agent.js")) { Write-Host '连接程序没下载下来，请检查网络后重跑这行命令' -ForegroundColor Red; return }
# 名字、文件夹、口令写进 UTF-8 配置文件；cmd 和 vbs 里只留英文路径（用 %USERPROFILE%），中文用户名也不乱码
$utf8 = New-Object Text.UTF8Encoding $false
$cfg = @{ hub = $Hub; key = $Key; name = $Name; workdir = $WorkDir; bin = $Cb } | ConvertTo-Json
[IO.File]::WriteAllText("$Dir\config.json", $cfg, $utf8)
$up = $env:USERPROFILE
$rel = { param($p) if ($p.StartsWith($up, [StringComparison]::OrdinalIgnoreCase)) { '%USERPROFILE%' + $p.Substring($up.Length) } else { $p } }
$NodeR = & $rel $Node; $NodeDirR = & $rel $NodeDir; $CbDirR = & $rel (Split-Path $Cb)
$cmd = "@echo off`r`nchcp 65001 >nul`r`nset `"PATH=$CbDirR;$NodeDirR;%APPDATA%\npm;%PATH%`"`r`n`"$NodeR`" `"%USERPROFILE%\.wb-fleet\agent.js`" --config `"%USERPROFILE%\.wb-fleet\config.json`" >> `"%USERPROFILE%\.wb-fleet\agent.log`" 2>&1`r`n"
[IO.File]::WriteAllText("$Dir\run-agent.cmd", $cmd, $utf8)
# 挂了自动重启：外面套一层循环
$loop = "@echo off`r`n:loop`r`ncall `"%USERPROFILE%\.wb-fleet\run-agent.cmd`"`r`ntimeout /t 5 /nobreak >nul`r`ngoto loop`r`n"
[IO.File]::WriteAllText("$Dir\loop-agent.cmd", $loop, $utf8)
# WScript.Shell.Run 会展开 %USERPROFILE%
$vbs = "CreateObject(`"WScript.Shell`").Run `"cmd /c `"`"%USERPROFILE%\.wb-fleet\loop-agent.cmd`"`"`", 0, False`r`n"
[IO.File]::WriteAllText("$Dir\start-agent.vbs", $vbs, $utf8)

# 4. 登录 Windows 后自动连（放进「启动」文件夹），并马上启动（先停掉旧的）
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item "$Dir\start-agent.vbs" "$startup\WorkBuddy-fleet.vbs" -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*wb-fleet*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process wscript.exe -ArgumentList "`"$Dir\start-agent.vbs`""

Start-Sleep 3
Say "这台已接入总控，名字「$Name」，默认在 $WorkDir 干活。回总控网页就能看到它。"
$probe = ('Reply with OK only' | & $Cb -p --max-turns 1) 2>&1 | Out-String
if ($probe -match 'Authentication required|/login') {
  Write-Host "`n还差一步：这台的 WorkBuddy 命令行没登录。" -ForegroundColor Yellow
  Write-Host '运行 codebuddy ，输入 /login 按提示用 WorkBuddy 的账号登录，登好输入 /exit 就行。'
}

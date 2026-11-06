# 引导脚本：把真正的更新丢到「分离的后台进程」里做，自己立刻返回
# 这样派活的那条命令能马上拿到回执，不会因为连接程序被重启而卡住
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$U = '__HUB_URL__/update.ps1?t=__FLEET_KEY__'
$Dir = Join-Path $env:USERPROFILE '.wb-fleet'
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }

# 用当前这个 PowerShell 自己的可执行文件，避免 PATH 里找不到 powershell
$ps = 'powershell'
try { $p = (Get-Process -Id $PID).Path; if ($p) { $ps = $p } } catch { }

$log = Join-Path $Dir 'update.log'
$inner = "`$ProgressPreference='SilentlyContinue'; Start-Sleep -Seconds 4; irm '$U' | iex *> '$log'"

try {
  Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', $inner) -WindowStyle Hidden | Out-Null
} catch {
  # 分离失败就同步跑，至少能升级
  try { irm $U | iex } catch { Write-Host ('更新失败：' + $_.Exception.Message) -ForegroundColor Red; return }
}

Write-Host '更新已在后台开始（约 10 秒完成）。本机连接程序会短暂断线，随后自动重连。'
Write-Host "过程日志：$log"

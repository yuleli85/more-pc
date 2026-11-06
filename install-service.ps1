<#
.SYNOPSIS
    wb-fleet 总控（端口 8790）开机自启 + 心跳自愈 安装脚本

.DESCRIPTION
    用 Windows 计划任务实现「开机即启动、无需登录」，任务调用 start-hidden.vbs：
      - 启动器幂等：已在运行就不重复拉起，避免多实例抢端口
      - 开机触发（延迟 20 秒）+ 每 5 分钟心跳，进程被杀也能自动拉回
    以 SYSTEM 身份运行，不依赖当前登录用户。

    需管理员权限。操作：
      install     安装/覆盖任务（并立即启动一次）
      uninstall   停止进程并删除任务
      status      查看任务、进程、端口、启动日志
      start       立即触发一次任务
      stop        停止任务（含 node 进程）

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File C:\wb-fleet\install-service.ps1 -Action install
#>

[CmdletBinding()]
param(
    [ValidateSet('install','uninstall','status','start','stop')]
    [string]$Action = 'status',

    [string]$TaskName = 'wb-fleet-hub',

    [int]$HeartbeatMinutes = 5,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # 关掉 Invoke-WebRequest 的进度条，避免刷屏

$HubDir  = 'C:\wb-fleet'
$Vbs     = Join-Path $HubDir 'start-hidden.vbs'
$DataDir = Join-Path $HubDir 'data'
$LogFile = Join-Path $DataDir 'autostart.log'
$Port    = 8790

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host '[x] 需要管理员权限：请右键“以管理员身份运行”' -ForegroundColor Red
        exit 1
    }
}

function Get-HubProc {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*hub.js*' }
}

function Get-ListenProcId {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($c) { return $c.OwningProcess }
    return $null
}

function Show-Status {
    Write-Host '=== 计划任务 ===' -ForegroundColor Cyan
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        $i = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host ("  任务      : {0}" -f $TaskName)
        Write-Host ("  状态      : {0}" -f $t.State)
        Write-Host ("  运行身份  : {0}" -f $t.Principal.UserId)
        Write-Host ("  上次运行  : {0} (结果 {1})" -f $i.LastRunTime, $i.LastTaskResult)
        Write-Host ("  下次运行  : {0}" -f $i.NextRunTime)
    } else {
        Write-Host '  任务      : 不存在（未安装）'
    }

    Write-Host '=== 进程与端口 ===' -ForegroundColor Cyan
    $p = Get-HubProc
    if ($p) { foreach ($x in $p) { Write-Host ("  node PID  : {0}  启动于 {1}" -f $x.ProcessId, $x.CreationDate) } }
    else    { Write-Host '  node 进程 : 未运行' }

    $lp = Get-ListenProcId
    if ($lp) { Write-Host ("  端口 {0}   : 监听中 (PID {1})" -f $Port, $lp) }
    else     { Write-Host ("  端口 {0}   : 未监听" -f $Port) }

    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
        Write-Host ("  HTTP 自检 : {0} OK" -f $r.StatusCode) -ForegroundColor Green
    } catch {
        Write-Host '  HTTP 自检 : 失败' -ForegroundColor Yellow
    }

    if (Test-Path $LogFile) {
        Write-Host '=== 启动器日志（最后 6 行）===' -ForegroundColor Cyan
        Get-Content $LogFile -Tail 6 | ForEach-Object { Write-Host ("  " + $_) }
    }
}

function Install-HubTask {
    if (-not (Test-Path $Vbs)) { throw "找不到启动器: $Vbs" }
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) {
        Write-Host ("[!] 任务已存在（{0}），未加 -Force 不覆盖" -f $existing.State)
        return
    }

    $act = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" `
                                   -Argument ('"' + $Vbs + '"') `
                                   -WorkingDirectory $HubDir

    $trgBoot = New-ScheduledTaskTrigger -AtStartup
    try { $trgBoot.Delay = 'PT20S' } catch { Write-Host '[i] 未能设置启动延迟（不影响功能）' }

    # 心跳：每 N 分钟检查一次，进程不在就拉起来
    try {
        $rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
                    -RepetitionInterval (New-TimeSpan -Minutes $HeartbeatMinutes) `
                    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
        $trgBoot.Repetition = $rep
        $hb = "每 $HeartbeatMinutes 分钟心跳"
    } catch {
        $hb = '心跳设置失败（仅开机启动）'
        Write-Host ("[!] {0}" -f $hb) -ForegroundColor Yellow
    }

    $set = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $TaskName `
        -Action $act -Trigger $trgBoot -Settings $set -Principal $prn -Force `
        -Description ('WorkBuddy 总控 hub.js (http://111.231.76.102:8790) 开机自启 + ' + $hb) | Out-Null

    Write-Host ("[+] 已注册任务 {0}：开机启动（延迟20秒）+ {1}" -f $TaskName, $hb) -ForegroundColor Green

    if (-not (Get-ListenProcId)) {
        Write-Host '[+] 服务未运行，立即触发一次...'
        Start-ScheduledTask -TaskName $TaskName
        for ($i = 0; $i -lt 25; $i++) {
            Start-Sleep -Milliseconds 800
            if (Get-ListenProcId) { break }
        }
    } else {
        Write-Host '[i] 服务已在运行，未重复启动（任务将在下次开机/心跳时接管）'
    }

    Start-Sleep -Milliseconds 500
    Show-Status
}

function Uninstall-HubTask {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host '[i] 任务不存在，无需卸载' } else {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Milliseconds 500
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host ("[-] 已删除任务 {0}" -f $TaskName) -ForegroundColor Yellow
    }

    foreach ($p in Get-HubProc) {
        try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false } catch { }
    }
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*wb-fleet*run.cmd*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false } catch { } }

    Write-Host '[-] 已停止 hub 进程'
    Write-Host '[i] 注意：启动文件夹里的“wb-fleet 总控.vbs”仍会在登录后自启，如需彻底关闭请一并删除'
}

Assert-Admin

switch ($Action) {
    'install'   { Install-HubTask }
    'uninstall' { Uninstall-HubTask }
    'status'    { Show-Status }
    'start'     { Start-ScheduledTask -TaskName $TaskName; Write-Host '[+] 已触发'; Start-Sleep -Milliseconds 800; Show-Status }
    'stop'      { Stop-ScheduledTask -TaskName $TaskName; Write-Host '[-] 已发送停止指令'; Start-Sleep -Milliseconds 500; Show-Status }
}

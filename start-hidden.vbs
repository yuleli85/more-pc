' wb-fleet 总控 启动器（幂等：已在运行则不重复启动）
' 被两处调用：
'   1) 启动文件夹里的副本（登录后自启）
'   2) 计划任务 wb-fleet-hub（开机启动 + 每 5 分钟心跳自愈）
' 手动验证：双击运行。若总控已在跑，不会有任何弹窗，但会往 data\autostart.log 写一行。

Option Explicit

Dim sh, fso, cmd, logFile, running
Dim tFile, wmi, procs, p, http, errNo

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

cmd     = "C:\wb-fleet\run.cmd"
logFile = "C:\wb-fleet\data\autostart.log"

' ---- 日志超过 512KB 先清空，避免长期累积 ----
On Error Resume Next
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 524288 Then
    Set tFile = fso.CreateTextFile(logFile, True)
    tFile.Close
  End If
End If
Err.Clear
On Error GoTo 0

If Not fso.FileExists(cmd) Then
  LogLine "错误：找不到 " & cmd
  WScript.Quit 1
End If

running = False

' ---- 探测 1：WMI 查 node.exe 命令行是否含 hub.js ----
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
  Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'")
  If Err.Number = 0 Then
    For Each p In procs
      If InStr(LCase(p.CommandLine & ""), "hub.js") > 0 Then running = True
    Next
  End If
End If
Err.Clear

' ---- 探测 2：HTTP 探测端口 ----
If Not running Then
  Set http = CreateObject("MSXML2.XMLHTTP")
  If Err.Number = 0 Then
    http.open "GET", "http://127.0.0.1:8790/", False
    http.send
    errNo = Err.Number
    If errNo = 0 Then running = True
  End If
  Err.Clear
End If
On Error GoTo 0

If running Then
  LogLine "已在运行，跳过"
  WScript.Quit 0
End If

' ---- 未运行：隐藏窗口拉起 run.cmd（内含崩溃重启循环）----
On Error Resume Next
sh.CurrentDirectory = "C:\wb-fleet\app"
sh.Run "cmd.exe /c """ & cmd & """", 0, False
If Err.Number <> 0 Then
  LogLine "启动失败：" & Err.Description
  Err.Clear
Else
  LogLine "已启动（隐藏窗口）"
End If
On Error GoTo 0

' ==================================================================
Sub LogLine(msg)
  Dim f
  On Error Resume Next
  Set f = fso.OpenTextFile(logFile, 8, True)
  If Err.Number = 0 Then
    f.WriteLine Now & "  " & msg
    f.Close
  End If
  Err.Clear
End Sub

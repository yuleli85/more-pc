@echo off
setlocal enabledelayedexpansion
set PORT=8790
set DATA_DIR=C:\wb-fleet\data
set PUBLIC_URL=http://111.231.76.102:8790
cd /d "C:\wb-fleet\app"
:loop
rem 日志由 hub.js 自己管（data\hub.log，超过 20MB 自动轮转）——
rem 这里不要重定向到文件，否则会写两份、而且 Windows 下删不掉正在写的文件。
"C:\Program Files\nodejs\node.exe" "C:\wb-fleet\app\hub.js"
ping -n 4 127.0.0.1 >nul
goto loop

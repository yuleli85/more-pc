@echo off
set PORT=8790
set DATA_DIR=C:\wb-fleet\data
set PUBLIC_URL=http://111.231.76.102:8790
cd /d "C:\wb-fleet\app"
:loop
"C:\Program Files\nodejs\node.exe" "C:\wb-fleet\app\hub.js" >> "C:\wb-fleet\data\hub.log" 2>&1
ping -n 4 127.0.0.1 >nul
goto loop

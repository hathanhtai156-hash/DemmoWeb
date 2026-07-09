@echo off
cd /d "%~dp0"
echo Dang khoi dong LogiPort Mart...
npm.cmd install
start http://localhost:4000/index.html
npm.cmd start
pause

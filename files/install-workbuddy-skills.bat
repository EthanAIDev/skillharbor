@echo off
title AI Gateway - 一键配置（WorkBuddy）
echo Downloading installer from the portal...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:TEMP+'\skillharbor-skills-install.ps1'; (New-Object System.Net.WebClient).DownloadFile('http://127.0.0.1:8900/files/install-workbuddy-skills.ps1',$p); & $p"
echo.
pause

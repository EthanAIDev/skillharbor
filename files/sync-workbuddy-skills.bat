@echo off
title SkillHarbor Skill Center - Sync skills now
rem Always run the portal's latest script: syncs skills AND upgrades older installs
rem (the local scheduled-task copy may hold the previous script version).
echo Pulling the latest skills from the portal...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:TEMP+'\dt-skills-sync.ps1'; (New-Object System.Net.WebClient).DownloadFile('http://127.0.0.1:8900/files/install-workbuddy-skills.ps1',$p); & $p"
echo.
echo Done. If WorkBuddy / Trae Work is running, restart it to see the skills.
pause

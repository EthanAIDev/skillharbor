@echo off
chcp 65001 >nul
title SkillHarbor Portal
cd /d %~dp0
echo [SkillHarbor] building production bundle...
call npm run build || goto :err
echo [SkillHarbor] starting server on port 8900 ...
node server.cjs 8900
goto :eof

:err
echo [SkillHarbor] build failed, abort.
pause

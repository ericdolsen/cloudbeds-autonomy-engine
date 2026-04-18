@echo off
title Gateway Park Autonomy Engine
color 0B
echo ========================================================
echo           GATEWAY PARK AUTOMATION SERVER
echo ========================================================
echo.
echo Initializing Server...
cd /d "%~dp0"
node server.js
pause

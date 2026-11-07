@echo off
title Link old workspace path to D drive
set "OLD=C:\Users\Administrator\WorkBuddy\2026-10-31-13-35-10"
set "NEW=D:\3d-desk-pet"

echo ============================================
echo  Link OLD path  -^>  D drive project
echo    OLD: %OLD%
echo    NEW: %NEW%
echo ============================================
echo.

if not exist "%NEW%\pet-app\main.js" (
  echo [ERROR] The D-drive copy is incomplete. Nothing changed.
  pause
  exit /b 1
)

if exist "%OLD%\pet-app" (
  echo [ABORT] Old path still contains project files. Nothing changed.
  pause
  exit /b 1
)

if exist "%OLD%" rd "%OLD%" 2>nul

if exist "%OLD%" (
  echo [FAILED] Cannot delete the old folder. It is still in use.
  echo          Please CLOSE WorkBuddy completely (including tray icon),
  echo          then run this script again.
  echo.
  pause
  exit /b 1
)

mklink /J "%OLD%" "%NEW%"

if exist "%OLD%\pet-app\main.js" (
  echo.
  echo [OK] Junction created successfully:
  echo      %OLD%
  echo      points to %NEW%
  echo.
  echo You can now reopen WorkBuddy with the old path.
) else (
  echo.
  echo [FAILED] Junction was not created. Send me a screenshot.
)
echo.
pause

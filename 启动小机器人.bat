@echo off
rem 3D desk pet launcher - double click to run in background
rem quit from the tray icon menu

set "HERE=%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

start "desk-pet" "%HERE%pet-app\node_modules\electron\dist\electron.exe" "%HERE%pet-app"

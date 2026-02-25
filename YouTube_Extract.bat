@echo off
cd /d D:\YouTube_Video_Downloader

start cmd /k node server.js

timeout /t 2 >nul
start "" http://localhost:3000
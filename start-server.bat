@echo off
setlocal
title Quiz Assistant - Local Backend
cd /d "%~dp0server"
if errorlevel 1 (
  echo [X] Cannot enter the server folder.
  pause
  exit /b 1
)

echo ============================================
echo  Quiz Assistant - starting local backend
echo ============================================
echo.

if not exist ".env" (
  echo [!] Missing server\.env
  echo     Copy .env.example to .env and fill OPENAI_API_KEY=your_key
  echo.
)

set "PY="
py -3 -c "import flask, flask_cors, requests, fontTools, brotli, numpy, PIL" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import flask, flask_cors, requests, fontTools, brotli, numpy, PIL" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  echo [i] Flask not found in your Python, installing requirements...
  python -m pip install -q -r requirements.txt
  if errorlevel 1 python -m pip install -q -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  python -c "import flask, flask_cors, requests, fontTools, brotli, numpy, PIL" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  echo [X] No usable Python with Flask found.
  echo     Run manually:  python -m pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)

echo Python : %PY%
echo Listen : http://127.0.0.1:8787
echo Keep this window open while using the extension.
echo.
%PY% app.py

echo.
echo Backend stopped. Press any key to close.
pause >nul

@echo off
setlocal
title Quiz Assistant - Config Check
cd /d "%~dp0server"

echo ============================================
echo  Config check - key is masked
echo ============================================
echo.

set "PY="
py -3 -c "import flask" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import flask" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo [X] Python with Flask not found. Run start-server.bat first.
  echo.
  pause
  exit /b 1
)

%PY% -c "import os,sys;sys.path.insert(0,'.');import app;k=os.environ.get('OPENAI_API_KEY') or '';print('env lines :',app._LOADED_ENV);print('has_key   :',bool(k));print('key       :',(k[:6]+'...'+k[-4:]) if len(k)>12 else '(empty)');print('base_url  :',os.environ.get('OPENAI_BASE_URL','https://api.openai.com/v1'));print('model     :',os.environ.get('OPENAI_MODEL','gpt-4o-mini'));print('samples   :',app.N_SAMPLES)"

echo.
echo If has_key is False, OPENAI_API_KEY in server\.env is still empty.
echo.
pause

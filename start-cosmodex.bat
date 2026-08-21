@echo off
REM ===========================================================================
REM  Cosmodex — start a local server and open the app.
REM
REM  Put this file next to index.html and double-click it (or use a shortcut).
REM  Serving over http://localhost avoids every problem that comes with opening
REM  index.html directly: file:// has no IndexedDB, so nothing would save.
REM
REM  Close the window to stop the server.
REM ===========================================================================
setlocal
title Cosmodex

REM --- serve the folder this script lives in -------------------------------
cd /d "%~dp0"

REM --- change this if 8765 is taken ---------------------------------------
set "PORT=8765"

REM --- find Python, whichever way it is installed --------------------------
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY where python3 >nul 2>&1 && set "PY=python3"

if not defined PY (
  echo.
  echo   Python was not found on PATH.
  echo.
  echo   Try opening a terminal and running:  py --version
  echo   If that works but this does not, tell Claude what it printed.
  echo.
  pause
  exit /b 1
)

REM --- open the browser once the server has had a moment to bind ----------
REM  (ping is used as the wait: it works everywhere, timeout does not always.)
REM  (no quotes around the URL: nested quotes break this line in batch.)
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/"

echo.
echo   Cosmodex is running at http://localhost:%PORT%/
echo   Keep this window open. Close it to stop.
echo.
%PY% -m http.server %PORT%

REM --- if the server exits immediately, the port is probably in use -------
if errorlevel 1 (
  echo.
  echo   The server stopped unexpectedly. Port %PORT% may already be in use --
  echo   edit this file and change PORT to something else, e.g. 8766.
  echo.
  pause
)

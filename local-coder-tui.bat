@echo off
setlocal
title Local Coder (terminal)

rem Double-click launcher for the TERMINAL version of the IDE.
rem The windowed version is local-coder.bat; this one is for SSH sessions and machines with
rem no desktop, and runs the same engine.
rem
rem The checks below are not ceremony. Every one of them is a failure that otherwise shows up
rem as a Python traceback in a console window that closes before it can be read, or - worse -
rem as the app starting and reporting "workspace not configured" for a workspace that is
rem configured perfectly well. Failing here with the actual fix on screen is the whole point.

cd /d "%~dp0ide"

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Python was not found on PATH.
    echo   Install it with:  winget install Python.Python.3.13
    echo   then close and reopen this window.
    echo.
    pause
    exit /b 1
)

if not exist "..\host-bridge\dist\mcp-main.js" (
    echo.
    echo   The MCP server has not been built.
    echo   Build it with:  pnpm --filter host-bridge build
    echo.
    pause
    exit /b 1
)

if not exist "..\host-bridge\.env" (
    echo.
    echo   host-bridge\.env is missing - the app reads the sandbox settings from it.
    echo   Copy host-bridge\.env.example to host-bridge\.env and set BRIDGE_WORKSPACE_ROOT
    echo   to the folder the local model is allowed to read and write.
    echo.
    pause
    exit /b 1
)

rem `python -m local_coder` needs the package importable. It is installed editable, so this
rem only fails on a fresh checkout - in which case say so rather than dumping a ModuleNotFound.
python -c "import local_coder" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   The local_coder package is not installed for this Python.
    echo   Install it with:  python -m pip install --user -e .
    echo   ^(run that from the ide folder^)
    echo.
    pause
    exit /b 1
)

rem Ollama is checked last because it is the one thing that can be fixed without restarting
rem this launcher - the app itself reports it clearly and keeps running.
curl -s -o nul --max-time 3 http://localhost:11434/api/tags
if errorlevel 1 (
    echo.
    echo   Warning: Ollama does not answer on http://localhost:11434
    echo   Start it with:  ollama serve
    echo   Starting anyway - the app will show the same thing in its log.
    echo.
    timeout /t 3 >nul
)

python -m local_coder

rem A non-zero exit means a traceback the user needs to see; hold the window open for it.
if errorlevel 1 (
    echo.
    echo   Local Coder exited with an error - the message above is the useful part.
    echo.
    pause
)

endlocal

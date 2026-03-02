@echo off
echo Starting Waterpath Scenario Builder...
echo.

REM Check if Docker is running
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running or not installed.
    echo Please start Docker Desktop and try again.
    pause
    exit /b 1
)

echo Docker is running. Starting containers...
echo.

REM Pull the GLOWPA image if not already present
echo Pulling GLOWPA image...
docker pull docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1

REM Start the containers in foreground (they will stop when you close this window)
echo Starting all containers...
echo.

REM Start containers in background first to check when they're ready
docker compose up --build -d

REM Wait for the webapp to be ready (check if port 3000 is responding)
echo Waiting for webapp to be ready...
:wait_loop
timeout /t 3 /nobreak >nul
powershell -Command "try { Invoke-WebRequest -Uri http://localhost:3000 -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo Still waiting for webapp...
    goto wait_loop
)

echo Webapp is ready! Opening browser...
start http://localhost:3000

echo.
echo Browser opened. Bringing containers to foreground...
echo Press Ctrl+C to stop all containers.
echo.

REM Now show the logs in foreground
docker compose logs -f

echo.
echo Containers have stopped.
pause

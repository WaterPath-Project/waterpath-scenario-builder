@echo off
echo Stopping Waterpath Scenario Builder containers...
echo.

docker compose down

if errorlevel 0 (
    echo ✅ All containers stopped successfully!
) else (
    echo ❌ Error stopping containers.
)

echo.
pause

@echo off
echo Running GLOWPA Model via Docker...
echo.

REM Check if containers are running
docker ps | findstr glowpa-container >nul
if errorlevel 1 (
    echo Error: GLOWPA container is not running.
    echo Please start the application first with start.bat
    pause
    exit /b 1
)

REM Run the example model
echo Executing example_model.R...
docker exec glowpa-container Rscript /app/input/example_model.R

if errorlevel 0 (
    echo.
    echo ✅ Model execution completed!
    echo Check the data\output\ directory for results.
    echo.
    echo Generated files:
    dir /b data\output\
) else (
    echo.
    echo ❌ Model execution failed.
    echo Check the container logs: docker logs glowpa-container
)

echo.
pause

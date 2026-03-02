@echo off
echo ======================================
echo Starting WaterPath Development Server
echo ======================================
echo.
echo This will start the application in development mode with hot reload enabled.
echo Frontend changes will automatically refresh in your browser.
echo Backend changes will automatically restart the Flask server.
echo.

REM Stop any existing containers
echo Stopping existing containers...
docker compose -f docker-compose.development.yml down

REM Start development containers
echo Starting development containers...
docker compose -f docker-compose.development.yml up --build -d

REM Wait for services to be ready
echo.
echo Waiting for services to start...
timeout /t 10 /nobreak > nul

REM Check if containers are running
echo.
echo Checking container status...
docker compose -f docker-compose.development.yml ps

REM Open browser automatically after a short delay
echo.
echo Opening browser in 10 seconds...
timeout /t 10 /nobreak > nul
start http://localhost:3000

echo.
echo ======================================
echo   Development server is running!
echo ======================================
echo Frontend: http://localhost:3000
echo Backend:  http://localhost:5000
echo GloWPa:   http://localhost:8080
echo.
echo To view logs: docker compose -f docker-compose.development.yml logs -f
echo To stop:      docker compose -f docker-compose.development.yml down
echo.
echo Press Ctrl+C to stop watching logs...

REM Follow logs
docker compose -f docker-compose.development.yml logs -f

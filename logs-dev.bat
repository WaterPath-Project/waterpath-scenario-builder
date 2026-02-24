@echo off
echo Viewing Development Server Logs...
echo Press Ctrl+C to stop viewing logs.
echo.
docker-compose -f docker-compose.development.yml logs -f

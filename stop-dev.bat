@echo off
echo Stopping WaterPath Development Server...
docker-compose -f docker-compose.development.yml down
echo Development server stopped.
pause

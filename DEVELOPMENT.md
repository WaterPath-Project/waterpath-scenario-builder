# WaterPath Scenario Builder - Development Setup

## Hot Reload Development Environment

This project now includes a hot reload development environment that automatically refreshes your browser when you make changes to the frontend code and restarts the backend when you make changes to the Python code.

## Quick Start

### Development Mode (with Hot Reload)
```bash
# Start development environment
start-dev.bat

# Or manually:
docker-compose -f docker-compose.development.yml up --build -d
```

### Production Mode
```bash
# Start production environment
start.bat

# Or manually:
docker-compose up --build -d
```

## Development Features

### Frontend Hot Reload
- ✅ **Instant Updates**: Changes to React components (.jsx files) are reflected immediately
- ✅ **CSS Hot Reload**: Tailwind CSS and style changes update without page refresh
- ✅ **Fast Refresh**: React state is preserved during updates when possible
- ✅ **Error Overlay**: Build errors are displayed directly in the browser

### Backend Auto-Restart
- ✅ **Flask Debug Mode**: Backend automatically restarts when Python files change
- ✅ **API Hot Reload**: Changes to Flask routes and API endpoints are immediate
- ✅ **Debug Information**: Detailed error messages and stack traces

## Available Scripts

### Development
- `start-dev.bat` - Start development environment with hot reload
- `stop-dev.bat` - Stop development environment
- `logs-dev.bat` - View development logs

### Production
- `start.bat` - Start production environment
- `stop.bat` - Stop production environment

## Development Workflow

1. **Start Development Environment**:
   ```bash
   .\start-dev.bat
   ```

2. **Make Changes**:
   - Edit files in `webapp/frontend/src/` for frontend changes
   - Edit files in `webapp/backend/` for backend changes
   - Changes are automatically detected and applied

3. **View Your Changes**:
   - Frontend: http://localhost:3000 (auto-refreshes)
   - Backend API: http://localhost:5000 (auto-restarts)
   - GloWPa: http://localhost:8080

4. **Debug Issues**:
   ```bash
   # View logs for all services
   .\logs-dev.bat
   
   # View specific service logs
   docker-compose -f docker-compose.development.yml logs frontend
   docker-compose -f docker-compose.development.yml logs backend
   ```

## Technical Details

### Frontend (React + Vite)
- **Hot Module Replacement (HMR)**: Instant updates without losing component state
- **File Watching**: Uses polling to detect changes on Windows
- **Source Maps**: Full debugging support in browser dev tools
- **Error Handling**: Build errors displayed as overlay

### Backend (Flask)
- **Debug Mode**: Automatic restart on file changes
- **Source Mounting**: Backend source code is mounted as volume
- **Error Reporting**: Detailed Flask debug information
- **API Endpoints**: All case study and scenario management APIs

### Docker Configuration
- **Separate Containers**: Frontend and backend in separate containers for better isolation
- **Volume Mounting**: Source code mounted for immediate change detection
- **Development Optimized**: Faster builds and better debugging experience

## Port Configuration

| Service  | Development | Production | Description |
|----------|-------------|------------|-------------|
| Frontend | 3000        | 3000       | React app with Vite dev server |
| Backend  | 5000        | 5000       | Flask API server |
| GloWPa   | 8080        | 8080       | GloWPa R model container |

## Troubleshooting

### Hot Reload Not Working
1. Ensure you're using the development environment: `start-dev.bat`
2. Check that files are being mounted correctly:
   ```bash
   docker-compose -f docker-compose.development.yml logs frontend
   ```
3. On Windows, polling is enabled for file watching

### Backend Changes Not Applied
1. Check Flask debug mode is enabled:
   ```bash
   docker-compose -f docker-compose.development.yml logs backend
   ```
2. Ensure you see "Debug mode: on" in the logs

### Port Conflicts
If ports are already in use:
1. Stop existing containers: `docker-compose -f docker-compose.development.yml down`
2. Check for other processes using ports 3000, 5000, or 8080
3. Update port mappings in `docker-compose.development.yml` if needed

## Performance Notes

- **Development**: Optimized for fast iteration and debugging
- **Production**: Optimized for performance and security
- **File Watching**: Uses polling on Windows for compatibility
- **Build Times**: Development builds are faster but larger

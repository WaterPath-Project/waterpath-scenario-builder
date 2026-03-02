# Development Mode Guide

This guide explains how to run the application in development mode with hot reload enabled and proper SPA routing.

## Issues Addressed

### 1. Hot Reload Not Working
In production mode (`docker-compose.yml`), the frontend is built once and served as static files. Changes to frontend code require rebuilding the container.

### 2. URL Refresh 404 Errors
When using React Router with BrowserRouter, refreshing the page on routes like `/scenarios` or `/analytics` should work. The backend has been configured with a catch-all route to serve `index.html` for all non-API routes.

## Running in Development Mode

### Start Development Servers

**Windows:**
```batch
.\start-dev.bat
```

**Linux/Mac:**
```bash
./start-dev.sh
```

Or manually:
```bash
docker-compose -f docker-compose.development.yml up --build
```

### What Changes in Development Mode?

1. **Frontend (Port 3000)**
   - Runs Vite dev server with Hot Module Replacement (HMR)
   - File changes automatically reflect in browser
   - Source code is mounted from `./webapp/frontend`
   - Fast refresh for React components

2. **Backend (Port 5000)**
   - Flask runs with `--debug` flag
   - Auto-reloads on Python file changes
   - Source code is mounted from `./webapp/backend`

3. **Volumes**
   - Frontend and backend source code are mounted
   - `node_modules` uses an anonymous volume to avoid conflicts
   - `data` directory is shared for case study access

## Development vs Production

### Development Mode (`docker-compose.development.yml`)
- **Frontend**: Separate container running Vite dev server
- **Backend**: Separate container running Flask in debug mode
- **Hot Reload**: ✅ Enabled for both frontend and backend
- **Build Time**: Faster (no build step)
- **Use Case**: Active development

### Production Mode (`docker-compose.yml`)
- **Frontend**: Built and served as static files from single container
- **Backend**: Runs Flask in production mode from same container
- **Hot Reload**: ❌ Disabled
- **Build Time**: Slower (React build required)
- **Use Case**: Deployment, testing final build

## Accessing the Application

### Development Mode
- **Frontend**: http://localhost:3000 (Vite dev server)
- **Backend API**: http://localhost:5000 (Flask)
- **GloWPa**: http://localhost:8080

### Production Mode
- **Frontend**: http://localhost:3000 (Flask serving static React build)
- **Backend API**: http://localhost:5000 (Flask)
- **GloWPa**: http://localhost:8080

## Common Commands

### View Logs
```bash
# All services
docker-compose -f docker-compose.development.yml logs -f

# Specific service
docker-compose -f docker-compose.development.yml logs -f frontend
docker-compose -f docker-compose.development.yml logs -f backend
```

### Stop Containers
```bash
docker-compose -f docker-compose.development.yml down
```

### Rebuild After Dependency Changes
```bash
# If you change package.json or requirements.txt
docker-compose -f docker-compose.development.yml up --build
```

### Reset Everything
```bash
docker-compose -f docker-compose.development.yml down -v
docker-compose -f docker-compose.development.yml up --build
```

## Troubleshooting

### Hot Reload Not Working on Windows
The configuration uses `CHOKIDAR_USEPOLLING=true` and Vite's `usePolling: true` to enable file watching in Docker on Windows. If it still doesn't work:

1. Check that volumes are mounted correctly:
   ```bash
   docker-compose -f docker-compose.development.yml ps
   ```

2. Verify file changes are detected:
   ```bash
   docker-compose -f docker-compose.development.yml logs -f frontend
   ```

3. Try increasing the polling interval in `vite.config.js`:
   ```javascript
   watch: {
     usePolling: true,
     interval: 2000,  // Increase from 1000 to 2000ms
   }
   ```

### 404 on Page Refresh
If you still get 404 errors when refreshing pages:

1. **Development Mode**: Vite dev server handles routing automatically
2. **Production Mode**: Flask's catch-all route serves `index.html` for all non-API routes

To verify the catch-all route is working, check Flask logs:
```bash
docker logs webapp-container
```

You should see debug messages like:
```
[DEBUG] Catch-all route hit with path: 'scenarios'
[DEBUG] File doesn't exist, serving index.html for SPA routing
```

### Port Conflicts
If ports 3000, 5000, or 8080 are already in use:

1. Stop conflicting services
2. Or modify ports in `docker-compose.development.yml`:
   ```yaml
   ports:
     - "3001:3000"  # Use 3001 instead of 3000
   ```

## File Structure

```
webapp/
├── backend/
│   └── app.py          # Flask backend (mounted in dev mode)
├── frontend/
│   ├── src/            # React source (mounted in dev mode)
│   ├── package.json
│   └── vite.config.js  # Vite configuration with polling
├── Dockerfile          # Production build
├── Dockerfile.dev.backend    # Backend dev container
├── Dockerfile.dev.frontend   # Frontend dev container
└── requirements.txt
```

## Tips

1. **Use Development Mode for Coding**: Always use `docker-compose.development.yml` when actively developing
2. **Use Production Mode for Testing**: Test with `docker-compose.yml` before deploying
3. **Browser DevTools**: React DevTools and Redux DevTools work in development mode
4. **Console Logs**: Check browser console and container logs for debugging

## Next Steps

- Code changes in `webapp/frontend/src` will automatically reload in browser
- Python changes in `webapp/backend` will automatically restart Flask
- Case study data is preserved between restarts (mounted volume)

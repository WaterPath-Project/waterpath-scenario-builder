# Waterpath Scenario Builder

A multi-container Docker application that runs two essential services:
1. **GLOWPA Container** - Running the GLOWPA-R application
2. **Web Application** - A Python Flask backend with React frontend

## 🚀 Quick Start

### Prerequisites
- Docker Desktop installed and running
- Internet connection (for pulling Docker images)

### Running the Application

#### Windows
Simply double-click `start.bat` to start all containers and launch the web application.

#### macOS/Linux
1. Make the script executable (one-time setup):
   ```bash
   chmod +x start.sh
   ```
2. Double-click `start.sh` or run from terminal:
   ```bash
   ./start.sh
   ```

### Stopping the Application

Simply close the terminal window or press `Ctrl+C` in the terminal. The containers will automatically stop when you close the application.

## 🌐 Access Points

Once running, you can access:

- **Main Web Application**: http://localhost:3000
- **GLOWPA Service**: http://localhost:8080
- **Flask Backend API**: http://localhost:5000

## 📁 Project Structure

```
waterpath-scenario-builder/
├── docker-compose.yml          # Container orchestration
├── start.bat / start.sh        # Startup scripts
├── data/                       # Data directories (mounted to GLOWPA)
│   ├── input/                  # Place input files here
│   ├── output/                 # Model results appear here
│   ├── config/                 # Configuration files
│   └── README.md              # Data directory documentation
└── webapp/
    ├── Dockerfile              # Web application container
    ├── requirements.txt        # Python dependencies
    ├── start.py               # Container startup script
    ├── backend/
    │   └── app.py             # Flask backend
    └── frontend/
        ├── package.json       # React dependencies
        ├── public/
        │   └── index.html     # HTML template
        └── src/
            ├── index.js       # React entry point
            ├── App.js         # Main React component
            └── index.css      # Styling
```

## 🔧 Development

### Backend Development
The Flask backend is located in `webapp/backend/app.py`. It provides:
- Health check endpoint (`/api/health`)
- GLOWPA status check (`/api/glowpa-status`)
- Sample data endpoint (`/api/data`)

### Frontend Development
The React frontend is in `webapp/frontend/`. Features:
- Modern, responsive UI
- Real-time status monitoring
- Integration with backend API
- Beautiful gradient design

### Adding New Features

1. **Backend**: Add new routes in `webapp/backend/app.py`
2. **Frontend**: Modify `webapp/frontend/src/App.js`
3. **Dependencies**: 
   - Python: Add to `webapp/requirements.txt`
   - Node.js: Add to `webapp/frontend/package.json`

## 🐳 Docker Services

### GLOWPA Container
- **Image**: `docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1`
- **Port**: 8080
- **Purpose**: GLOWPA-R application service
- **Volumes**: 
  - `./data/input` → `/app/input` (Input files)
  - `./data/output` → `/app/output` (Output files)
  - `./data/config` → `/app/config` (Configuration files)

### Web Application Container
- **Build**: Custom Dockerfile with Python Flask + React
- **Ports**: 3000 (frontend), 5000 (backend)
- **Purpose**: Main web interface and API

## 🛠️ Troubleshooting

### Docker Not Running
If you see "Docker is not running", ensure Docker Desktop is started.

### Port Conflicts
If ports 3000, 5000, or 8080 are in use:
1. Stop the conflicting applications
2. Or modify ports in `docker-compose.yml`

### Container Build Issues
Force rebuild with:
```bash
docker-compose up --build --force-recreate
```

### View Logs
```bash
docker-compose logs -f
```

## 📝 Customization

### Changing Ports
Edit `docker-compose.yml` to change port mappings:
```yaml
ports:
  - "NEW_PORT:CONTAINER_PORT"
```

### Environment Variables
Add environment variables in `docker-compose.yml`:
```yaml
environment:
  - CUSTOM_VAR=value
```

## 📊 Working with Data

### Input Data
1. Place your input files in the `data/input/` directory
2. Supported formats: CSV, GeoTIFF, Shapefiles, etc.
3. Files are automatically available to the GLOWPA container at `/app/input`

### Output Data
1. The GLOWPA model writes results to `data/output/`
2. Files include CSV results, TIFF outputs, and log files
3. Data persists on your local system after containers stop

### Configuration
1. Place configuration files in `data/config/`
2. Include model parameters, processing settings, etc.
3. Files are accessible to GLOWPA at `/app/config`

## 🧪 API Endpoints

- `GET /api/health` - Backend health check
- `GET /api/glowpa-status` - GLOWPA container status
- `GET /api/data` - Sample data (for testing)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with Docker
5. Submit a pull request

## 📄 License

This project is open source. Please check with your organization for specific licensing requirements.

---

**Happy coding! 🚀**

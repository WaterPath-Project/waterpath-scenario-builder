# GLOWPA Model Invocation Guide

This document explains the different ways to invoke the GLOWPA R model from outside the container.

## 🚀 Method 1: Web Application Interface (Recommended)

### Through the React Frontend
1. Open http://localhost:3000 in your browser
2. Use the web interface to:
   - Upload input files
   - Configure model parameters
   - Start model execution
   - Monitor progress
   - Download results

### API Endpoints
The Flask backend provides these endpoints:

#### Start Model Execution
```bash
POST http://localhost:5000/api/glowpa/run
Content-Type: application/json

{
  "script": "main.R",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

#### Execute Custom R Commands
```bash
POST http://localhost:5000/api/glowpa/execute-r
Content-Type: application/json

{
  "command": "source('/app/input/my_script.R')"
}
```

#### List Input Files
```bash
GET http://localhost:5000/api/files/input
```

#### List Output Files
```bash
GET http://localhost:5000/api/files/output
```

## 🔧 Method 2: Direct Docker Commands

### Execute R Script
```bash
# Run a specific R script
docker exec glowpa-container Rscript /app/input/your_script.R

# Run R commands interactively
docker exec -it glowpa-container R

# Execute R command directly
docker exec glowpa-container R -e "source('/app/input/model.R')"
```

### Copy and Execute
```bash
# Copy script to container and run
docker cp your_script.R glowpa-container:/tmp/
docker exec glowpa-container Rscript /tmp/your_script.R
```

## 🖥️ Method 3: Interactive R Session

### Start Interactive Session
```bash
# Start interactive R session in GLOWPA container
docker exec -it glowpa-container R
```

Then in the R console:
```r
# Set working directory
setwd("/app")

# Load your data
data <- read.csv("/app/input/your_data.csv")

# Run your model
source("/app/input/your_model.R")

# Save results
write.csv(results, "/app/output/results.csv")
```

## 📡 Method 4: HTTP API (if GLOWPA supports it)

If the GLOWPA container exposes HTTP endpoints:

```bash
# Check if GLOWPA has web interface
curl http://localhost:8080

# Submit job (example - depends on GLOWPA's API)
curl -X POST http://localhost:8080/api/run \
  -H "Content-Type: application/json" \
  -d '{"script": "model.R", "parameters": {...}}'
```

## 📂 Method 5: File-based Workflow

### Using Shared Volumes
1. **Prepare Script**: Create R script in `data/input/`
```r
# Example: data/input/run_model.R
library(glowpa)

# Read input data
input_data <- read.csv("/app/input/data.csv")

# Run model
results <- run_glowpa_model(input_data)

# Save outputs
write.csv(results, "/app/output/results.csv")
saveRDS(results, "/app/output/results.rds")

# Generate plots
png("/app/output/plot.png")
plot(results)
dev.off()
```

2. **Execute via Docker**:
```bash
docker exec glowpa-container Rscript /app/input/run_model.R
```

## 🔄 Method 6: Automated Workflows

### Using Docker Compose
Create a script that runs the model automatically:

```bash
# Windows (run_model.bat)
docker-compose exec glowpa Rscript /app/input/automated_model.R

# Linux/macOS (run_model.sh)
#!/bin/bash
docker-compose exec glowpa Rscript /app/input/automated_model.R
```

### Scheduled Execution
```bash
# Add to crontab for scheduled runs
0 2 * * * cd /path/to/project && docker-compose exec glowpa Rscript /app/input/daily_model.R
```

## 📋 Best Practices

### 1. File Organization
```
data/input/
├── data.csv              # Input data
├── parameters.json       # Model parameters
├── run_model.R          # Main model script
└── functions.R          # Helper functions

data/output/
├── results.csv          # Will be generated
├── plots/               # Generated plots
└── logs/                # Log files
```

### 2. Error Handling in R Scripts
```r
# Add error handling to your R scripts
tryCatch({
  # Your model code here
  source("/app/input/model.R")
  
  # Write success flag
  writeLines("SUCCESS", "/app/output/status.txt")
  
}, error = function(e) {
  # Write error to log
  writeLines(paste("ERROR:", e$message), "/app/output/error.log")
  writeLines("FAILED", "/app/output/status.txt")
})
```

### 3. Parameter Files
```json
// data/input/parameters.json
{
  "model_type": "water_flow",
  "resolution": 100,
  "time_steps": 365,
  "output_format": "csv"
}
```

Load in R:
```r
library(jsonlite)
params <- fromJSON("/app/input/parameters.json")
```

## 🔍 Monitoring and Debugging

### Check Container Logs
```bash
# View GLOWPA container logs
docker logs glowpa-container

# Follow logs in real-time
docker logs -f glowpa-container
```

### Check File System
```bash
# List files in container
docker exec glowpa-container ls -la /app/input
docker exec glowpa-container ls -la /app/output

# Check R installation
docker exec glowpa-container R --version
```

### Debugging R Scripts
```bash
# Run with debug output
docker exec glowpa-container R -e "options(error=traceback); source('/app/input/model.R')"
```

## 🎯 Recommended Workflow

1. **Prepare**: Place input files and R scripts in `data/input/`
2. **Test**: Use interactive R session to test your script
3. **Automate**: Use web API or Docker exec for automated runs
4. **Monitor**: Check `data/output/` for results and logs
5. **Scale**: Use the web application for user-friendly operation

Choose the method that best fits your use case:
- **Web UI**: For end users and interactive use
- **API calls**: For programmatic integration
- **Docker exec**: For scripting and automation
- **Interactive R**: For development and debugging

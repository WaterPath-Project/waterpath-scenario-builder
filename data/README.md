# GLOWPA Data Directories

This folder contains the data directories that are mounted into the GLOWPA container for input and output operations.

## Directory Structure

### `input/`
Place your input files here before running the GLOWPA model. The container will read files from this directory.

**Supported input formats:**
- CSV files
- GeoTIFF files
- Shapefile formats (.shp, .shx, .dbf, etc.)
- Configuration files
- Any other format supported by the GLOWPA-R model

### `output/`
The GLOWPA model will write its output files to this directory. Results will appear here after the model completes execution.

**Expected output formats:**
- CSV files with results
- TIFF/GeoTIFF files
- Log files
- Summary reports

### `config/` (optional)
Place configuration files or parameter files here if the GLOWPA model requires them.

## Usage Instructions

1. **Prepare Input Data:**
   - Copy your input files to the `input/` directory
   - Ensure files are in the correct format expected by GLOWPA
   - Add any configuration files to the `config/` directory

2. **Run the Application:**
   - Execute `start.bat` (Windows) or `start.sh` (macOS/Linux)
   - The GLOWPA container will have access to these directories

3. **Access Results:**
   - After the model runs, check the `output/` directory for results
   - Files will persist on your local system even after containers stop

## Container Mount Points

Inside the GLOWPA container, these directories are mounted as:
- `./data/input` → `/app/input`
- `./data/output` → `/app/output`
- `./data/config` → `/app/config`

## Notes

- Make sure you have read/write permissions on these directories
- The directories will be created automatically when you start the containers
- Data persists between container restarts
- You can access and modify files while containers are running

## Example Workflow

1. Place input data files in `input/`
2. Start the application with `start.bat`
3. Use the web interface (http://localhost:3000) to configure and run the model
4. Monitor progress through the web interface
5. Retrieve results from the `output/` directory
6. Copy results to your desired location if needed

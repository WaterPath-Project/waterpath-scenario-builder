#!/bin/bash

echo "Running GLOWPA Model via Docker..."
echo

# Check if containers are running
if ! docker ps | grep -q glowpa-container; then
    echo "Error: GLOWPA container is not running."
    echo "Please start the application first with ./start.sh"
    read -p "Press any key to continue..."
    exit 1
fi

# Run the example model
echo "Executing example_model.R..."
docker exec glowpa-container Rscript /app/input/example_model.R

if [ $? -eq 0 ]; then
    echo
    echo "✅ Model execution completed!"
    echo "Check the data/output/ directory for results."
    echo
    echo "Generated files:"
    ls -la data/output/
else
    echo
    echo "❌ Model execution failed."
    echo "Check the container logs: docker logs glowpa-container"
fi

echo
read -p "Press any key to continue..."

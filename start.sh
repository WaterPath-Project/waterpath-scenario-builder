#!/bin/bash

echo "Starting Waterpath Scenario Builder..."
echo

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker is not running or not installed."
    echo "Please start Docker and try again."
    read -p "Press any key to continue..."
    exit 1
fi

echo "Docker is running. Starting containers..."
echo

# Pull the GLOWPA image if not already present
echo "Pulling GLOWPA image..."
docker pull docker-registry.wur.nl/glowpa/glowpa-r/glowpa-main:0.2.1

# Start the containers in foreground (they will stop when you close this terminal)
echo "Starting all containers..."
echo

docker compose up --build

echo
echo "Containers have stopped."
read -p "Press any key to continue..."

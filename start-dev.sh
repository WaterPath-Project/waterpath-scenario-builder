#!/bin/bash
echo "🌊 Starting Waterpath Scenario Builder - Development Mode"
echo "============================================================"

echo "🔧 Building development containers..."
docker compose -f docker-compose.dev.yml build

echo "🚀 Starting development environment with hot reloading..."
docker compose -f docker-compose.dev.yml up

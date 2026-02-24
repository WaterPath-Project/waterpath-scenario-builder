#!/bin/bash

# Start Flask backend in background
cd /app/backend
python app.py &

# Serve the React frontend
cd /app/frontend/build
python -m http.server 3000

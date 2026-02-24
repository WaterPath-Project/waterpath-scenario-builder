#!/usr/bin/env python3
import subprocess
import time
import os
import sys

def start_backend():
    """Start the Flask backend server"""
    print("Starting Flask backend...")
    os.chdir('/app/backend')
    return subprocess.Popen([sys.executable, 'app.py'])

def main():
    print("Starting Waterpath Scenario Builder...")
    print("Current working directory:", os.getcwd())
    print("Contents of /app:")
    if os.path.exists('/app'):
        for item in os.listdir('/app'):
            item_path = os.path.join('/app', item)
            item_type = "DIR" if os.path.isdir(item_path) else "FILE"
            print(f"  {item_type}: {item}")
    
    # Check if frontend build exists
    frontend_build_path = '/app/frontend/build'
    if os.path.exists(frontend_build_path):
        print(f"✅ Frontend build directory found at {frontend_build_path}")
        build_files = os.listdir(frontend_build_path)
        print(f"Build contains {len(build_files)} files")
    else:
        print(f"❌ Frontend build directory not found at {frontend_build_path}")
        print("Available directories in /app:")
        if os.path.exists('/app'):
            for item in os.listdir('/app'):
                print(f"  {item}")
        sys.exit(1)
    
    # Start Flask backend (it will serve both API and React app)
    print("Starting Flask backend (serves both API and React frontend)...")
    backend_process = start_backend()
    
    print("✅ Application started successfully!")
    print("🌐 Web Application: http://localhost:3000")
    print("🚀 Flask Backend API: http://localhost:5000")
    
    try:
        # Wait for the backend process
        backend_process.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")
        backend_process.terminate()
        backend_process.wait()

if __name__ == "__main__":
    main()

if __name__ == "__main__":
    main()

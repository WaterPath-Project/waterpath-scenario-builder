#!/usr/bin/env python3
"""
GLOWPA Model Runner
===================

This script demonstrates how to invoke the GLOWPA model via the web API.
"""

import requests
import json
import time
import sys

# Configuration
WEBAPP_URL = "http://localhost:5000"
GLOWPA_URL = "http://localhost:8080"

def check_services():
    """Check if services are running"""
    try:
        # Check webapp
        response = requests.get(f"{WEBAPP_URL}/api/health", timeout=5)
        if response.status_code != 200:
            print("❌ WebApp service is not responding")
            return False
        
        # Check GLOWPA connection
        response = requests.get(f"{WEBAPP_URL}/api/glowpa-status", timeout=5)
        if response.status_code != 200:
            print("❌ GLOWPA service is not accessible")
            return False
            
        print("✅ All services are running")
        return True
        
    except requests.exceptions.RequestException as e:
        print(f"❌ Service check failed: {e}")
        print("Make sure containers are running with start.bat/start.sh")
        return False

def list_files(directory="input"):
    """List files in input or output directory"""
    try:
        response = requests.get(f"{WEBAPP_URL}/api/files/{directory}")
        if response.status_code == 200:
            data = response.json()
            files = data.get("files", [])
            print(f"📁 Files in {directory}/ directory: {files}")
            return files
        else:
            print(f"❌ Failed to list {directory} files")
            return []
    except Exception as e:
        print(f"❌ Error listing files: {e}")
        return []

def run_r_command(command):
    """Execute R command via API"""
    try:
        payload = {"command": command}
        response = requests.post(
            f"{WEBAPP_URL}/api/glowpa/execute-r",
            json=payload,
            timeout=300  # 5 minutes
        )
        
        if response.status_code == 200:
            result = response.json()
            print("✅ R command executed successfully")
            print("Result:", json.dumps(result, indent=2))
            return True
        else:
            print(f"❌ R command failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error executing R command: {e}")
        return False

def run_model(script_name="example_model.R", parameters=None):
    """Run GLOWPA model via API"""
    if parameters is None:
        parameters = {}
    
    try:
        payload = {
            "script": script_name,
            "parameters": parameters
        }
        
        print(f"🚀 Starting model execution: {script_name}")
        response = requests.post(
            f"{WEBAPP_URL}/api/glowpa/run",
            json=payload,
            timeout=300
        )
        
        if response.status_code == 200:
            result = response.json()
            print("✅ Model execution started successfully")
            print("Result:", json.dumps(result, indent=2))
            return True
        else:
            print(f"❌ Model execution failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Error running model: {e}")
        return False

def main():
    print("GLOWPA Model Runner")
    print("==================")
    print()
    
    # Check services
    if not check_services():
        sys.exit(1)
    
    print()
    
    # List input files
    input_files = list_files("input")
    
    # List output files (before)
    print("\n📂 Output files before execution:")
    list_files("output")
    
    print("\n" + "="*50)
    
    # Method 1: Direct R command execution
    print("\n🔧 Method 1: Direct R Command")
    r_command = 'source("/app/input/example_model.R")'
    if run_r_command(r_command):
        print("✅ Direct R command completed")
    
    # Wait a bit for file system sync
    time.sleep(2)
    
    # Method 2: Model execution via API
    print("\n🚀 Method 2: API Model Execution")
    parameters = {
        "output_format": "csv",
        "generate_plots": True,
        "log_level": "INFO"
    }
    
    if run_model("example_model.R", parameters):
        print("✅ API model execution completed")
    
    # Wait for completion
    time.sleep(3)
    
    # List output files (after)
    print("\n📂 Output files after execution:")
    output_files = list_files("output")
    
    if output_files:
        print(f"\n✅ Generated {len(output_files)} output files:")
        for file in output_files:
            print(f"   - {file}")
        print("\nCheck the data/output/ directory for results!")
    else:
        print("\n⚠️  No output files found. Check the container logs for errors.")
    
    print("\n" + "="*50)
    print("Model execution completed!")

if __name__ == "__main__":
    main()

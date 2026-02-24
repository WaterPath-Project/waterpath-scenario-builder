#!/usr/bin/env python3
"""
Test script to verify baseline scenario CSV creation functionality
"""

import os
import sys
import tempfile
import shutil
from datetime import datetime
import uuid

# Add the webapp backend to the Python path
sys.path.append(os.path.join(os.path.dirname(__file__), 'webapp', 'backend'))

def test_baseline_creation():
    """Test that the baseline CSV creation function works correctly"""
    
    # Import the function from app.py
    try:
        from app import create_baseline_scenario_in_csv
        print("✅ Successfully imported create_baseline_scenario_in_csv function")
    except ImportError as e:
        print(f"❌ Failed to import function: {e}")
        return False
    
    # Create a temporary case study structure for testing
    test_case_study_id = str(uuid.uuid4())
    test_data_dir = os.path.join(tempfile.gettempdir(), 'test_waterpath', test_case_study_id)
    
    try:
        # Create the directory structure
        os.makedirs(test_data_dir, exist_ok=True)
        baseline_dir = os.path.join(test_data_dir, 'input', 'baseline')
        config_dir = os.path.join(test_data_dir, 'config')
        os.makedirs(baseline_dir, exist_ok=True)
        os.makedirs(config_dir, exist_ok=True)
        
        # Create some test CSV files in the baseline folder
        test_csv_files = ['water_demand.csv', 'water_supply.csv', 'water_treatment.csv']
        for csv_file in test_csv_files:
            csv_path = os.path.join(baseline_dir, csv_file)
            with open(csv_path, 'w') as f:
                f.write("column1,column2,column3\n")
                f.write("value1,value2,value3\n")
        
        print(f"✅ Created test directory structure at: {test_data_dir}")
        print(f"✅ Created {len(test_csv_files)} test CSV files")
        
        # Create a mock case study object
        mock_case_study = {
            "id": test_case_study_id,
            "name": "Test Case Study",
            "folder_path": test_data_dir
        }
        
        # Test the function
        print("\n🔄 Testing create_baseline_scenario_in_csv function...")
        try:
            create_baseline_scenario_in_csv(mock_case_study, test_csv_files)
            print("✅ Function executed without errors")
        except Exception as e:
            print(f"❌ Function execution failed: {e}")
            return False
        
        # Check if the CSV file was created
        scenario_metadata_path = os.path.join(config_dir, 'scenario_metadata.csv')
        if os.path.exists(scenario_metadata_path):
            print("✅ scenario_metadata.csv file was created")
            
            # Read and verify the contents
            with open(scenario_metadata_path, 'r') as f:
                content = f.read()
                print(f"\n📄 Contents of scenario_metadata.csv:")
                print(content)
                
                # Check if expected scenarios are present
                expected_scenarios = len(test_csv_files) + 1  # individual + overall baseline
                lines = content.strip().split('\n')
                data_lines = len(lines) - 1  # subtract header
                
                if data_lines == expected_scenarios:
                    print(f"✅ Correct number of scenarios created: {data_lines}")
                else:
                    print(f"⚠️  Expected {expected_scenarios} scenarios, got {data_lines}")
                
                # Check if baseline scenarios are properly marked
                if 'baseline' in content.lower():
                    print("✅ Baseline scenarios are properly identified")
                else:
                    print("⚠️  Baseline scenarios not found or not properly marked")
                    
        else:
            print("❌ scenario_metadata.csv file was not created")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Test setup failed: {e}")
        return False
    
    finally:
        # Clean up
        if os.path.exists(test_data_dir):
            shutil.rmtree(test_data_dir, ignore_errors=True)
            print(f"\n🧹 Cleaned up test directory")

if __name__ == "__main__":
    print("🧪 Testing Baseline Scenario CSV Creation")
    print("=" * 50)
    
    success = test_baseline_creation()
    
    print("\n" + "=" * 50)
    if success:
        print("🎉 All tests passed! The baseline creation functionality is working correctly.")
    else:
        print("💥 Tests failed. Check the implementation.")

#!/usr/bin/env python3
"""
This script removes duplicate function definitions from app.py
"""

import re

def clean_app_file():
    # Read the current app.py file
    with open('webapp/backend/app.py', 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Split into lines for processing
    lines = content.split('\n')
    
    # Track seen function definitions to avoid duplicates
    seen_functions = set()
    cleaned_lines = []
    skip_until_next_function = False
    
    for i, line in enumerate(lines):
        # Check if this is a function definition
        if line.strip().startswith('def '):
            func_name = line.strip().split('(')[0].replace('def ', '')
            if func_name in seen_functions:
                # Skip this duplicate function
                skip_until_next_function = True
                continue
            else:
                seen_functions.add(func_name)
                skip_until_next_function = False
        
        # Check if this is a route decorator that we've seen before
        if line.strip().startswith('@frontend_app.route') or line.strip().startswith('@app.route'):
            # Look ahead to get the function name
            j = i + 1
            while j < len(lines) and not lines[j].strip().startswith('def '):
                j += 1
            if j < len(lines):
                func_line = lines[j].strip()
                if func_line.startswith('def '):
                    func_name = func_line.split('(')[0].replace('def ', '')
                    if func_name in seen_functions:
                        skip_until_next_function = True
                        continue
        
        # Check if we should stop skipping
        if skip_until_next_function:
            if (line.strip().startswith('@') and 
                (line.strip().startswith('@frontend_app.route') or 
                 line.strip().startswith('@app.route') or
                 line.strip().startswith('@socketio'))):
                skip_until_next_function = False
            else:
                continue  # Skip this line
        
        cleaned_lines.append(line)
    
    # Join the cleaned lines back together
    cleaned_content = '\n'.join(cleaned_lines)
    
    # Write the cleaned content back to the file
    with open('webapp/backend/app.py', 'w', encoding='utf-8') as f:
        f.write(cleaned_content)
    
    print("Removed duplicate function definitions from app.py")

if __name__ == '__main__':
    clean_app_file()

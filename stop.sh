#!/bin/bash

echo "Stopping Waterpath Scenario Builder containers..."
echo

docker-compose down

if [ $? -eq 0 ]; then
    echo "✅ All containers stopped successfully!"
else
    echo "❌ Error stopping containers."
fi

echo
read -p "Press any key to continue..."

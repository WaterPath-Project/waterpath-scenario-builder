FROM node:18-alpine as frontend

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM python:3.9-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python backend
COPY backend/ ./backend/

# Copy built frontend
COPY --from=frontend /app/frontend/dist ./frontend/build/

# Expose ports
EXPOSE 3000 5000

# Create startup script
COPY start.py .

CMD ["python", "start.py"]

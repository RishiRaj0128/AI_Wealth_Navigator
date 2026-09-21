FROM python:3.11-slim

WORKDIR /app

# Install system dependencies needed for compiling or network operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy production requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY app/ ./app/

# Expose FastAPI application port
EXPOSE 8000

# Set environment variables for Python
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Start the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

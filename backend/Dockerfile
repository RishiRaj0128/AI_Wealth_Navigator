# Wealth Navigator AI — backend
#
# Build context is the REPOSITORY ROOT, not backend/, because the image also
# needs scripts/seed_wealth_demo.py to seed demo data inside the container:
#
#   docker build -f backend/Dockerfile -t wealth-navigator-api .

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/backend

WORKDIR /app

# psycopg2-binary ships its own libpq, so no build toolchain is needed. curl is
# here only for the container health check.
RUN apt-get update \
 && apt-get install --no-install-recommends -y curl \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer is cached until requirements.txt changes.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --upgrade pip && pip install -r backend/requirements.txt

COPY backend/ ./backend/
COPY scripts/ ./scripts/

# Never run as root.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Hits the real health endpoint, which runs SELECT 1 against PostgreSQL — so an
# unreachable database marks the container unhealthy rather than silently
# serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

# No --reload in production. Workers are modest because each request holds a
# short-lived psycopg2 connection.
CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2", "--app-dir", "/app/backend"]

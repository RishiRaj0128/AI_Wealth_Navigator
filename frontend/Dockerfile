# Wealth Navigator AI — frontend
#
# Build context is the frontend/ directory:
#   docker build -t wealth-navigator-web frontend/
#
# The API base URL is baked in at build time (Vite inlines import.meta.env), so
# pass it as a build argument rather than a runtime environment variable:
#   docker build --build-arg VITE_API_BASE=https://api.example.com/api -t ... frontend/

FROM node:20-alpine AS build

WORKDIR /app

# Dependencies first so this layer caches until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# ---------------------------------------------------------------------------
# Static serving. The app is a client-side SPA with no router, but nginx must
# still fall back to index.html so a deep link or a hard refresh does not 404.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html

RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  server_name _;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  gzip on;' \
  '  gzip_types text/css application/javascript application/json image/svg+xml;' \
  '  location /assets/ {' \
  '    expires 1y;' \
  '    add_header Cache-Control "public, immutable";' \
  '  }' \
  '  location / {' \
  '    try_files $uri $uri/ /index.html;' \
  '  }' \
  '}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

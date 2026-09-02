# No build step — vanilla JS frontend served straight from public/.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so the dependency layer caches across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Drop root. The node image ships an unprivileged 'node' user.
USER node

# Cloud Run injects PORT; server.js falls back to 8080 locally.
EXPOSE 8080
CMD ["node", "server.js"]

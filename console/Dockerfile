# Azure Local Deployment Console — stateless Linux container (AKS-Arc).
# node:22-slim, production deps only, runs as non-root. No Windows tooling (the
# engine runs on the per-run Windows worker, never in this image — DESIGN §1).
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install production dependencies first for layer caching. npm ci needs the lock;
# if only package.json exists the build falls back to npm install --omit=dev.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# Application source (server, libs, routes, migrations, static UI).
COPY . .

# Run as the built-in non-root 'node' user; own the app + the runs log tree.
RUN mkdir -p /data/runs && chown -R node:node /app /data
USER node

EXPOSE 3000

# Real health probe hits the app's health endpoint (db rw + migration + workers).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
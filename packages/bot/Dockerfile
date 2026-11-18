FROM node:26-trixie

# Chromium (headless WebGL snapshots via swiftshader) + node-canvas runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first for layer caching. In normal operation the compose file
# bind-mounts the host-installed monorepo node_modules over /app/node_modules,
# so this install is mainly a self-contained fallback.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./

# Node 26 runs TypeScript directly via native type stripping; no build step.
CMD ["node", "src/index.ts"]

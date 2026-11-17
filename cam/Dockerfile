FROM node:26-trixie

# chromium for headless WebGL screenshots (swiftshader)
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY cam.js ./
CMD ["node", "cam.js"]

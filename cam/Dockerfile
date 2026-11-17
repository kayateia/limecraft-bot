FROM node:26-trixie

# chromium for headless WebGL screenshots (swiftshader)
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2

WORKDIR /app
#COPY package.json package-lock.json* ./
#RUN npm install --omit=dev

CMD ["node", "cam.js"]

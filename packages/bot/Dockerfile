FROM node:26-trixie

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Bot code comes from a bind mount in docker-compose (live-edit friendly)
CMD ["node", "bot.js"]

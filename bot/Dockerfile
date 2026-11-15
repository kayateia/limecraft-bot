FROM node:26-trixie

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY bot.js ./

CMD ["node", "bot.js"]

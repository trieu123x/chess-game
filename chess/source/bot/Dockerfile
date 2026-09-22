FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV SERVER_HOST=server SERVER_PORT=5555 GAMES=50
CMD ["sh", "-c", "node bot.js --host $SERVER_HOST --port $SERVER_PORT --games $GAMES --out /out/load.csv"]

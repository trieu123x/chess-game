# Build context la thu muc source/ vi bot import ../common-js
FROM node:22-alpine
WORKDIR /app
COPY common-js/ ./common-js/
COPY bot/package*.json ./bot/
WORKDIR /app/bot
RUN npm install --omit=dev --no-audit --no-fund
COPY bot/ ./
ENV SERVER_HOST=server SERVER_PORT=5555 GAMES=50
CMD ["sh", "-c", "node bot.js --host $SERVER_HOST --port $SERVER_PORT --bots $GAMES --out /out/load.csv"]

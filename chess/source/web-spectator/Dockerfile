# Build context la thu muc source/ vi gateway import ../common-js
FROM node:22-alpine
WORKDIR /app
COPY common-js/ ./common-js/
COPY web-spectator/ ./web-spectator/
WORKDIR /app/web-spectator
# Khong co dependency: WebSocket duoc viet tay theo RFC 6455 trong websocket.js
ENV WS_PORT=8080 TCP_TARGET=server:5555
EXPOSE 8080
USER node
CMD ["node", "gateway.js"]

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV WS_PORT=8080 TCP_TARGET=server:5555
EXPOSE 8080
USER node
CMD ["node", "gateway.js"]

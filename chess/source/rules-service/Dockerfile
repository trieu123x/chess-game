# Build context la thu muc source/ vi rules-service import ../common-js
FROM node:22-alpine
WORKDIR /app
COPY common-js/ ./common-js/
COPY rules-service/package*.json ./rules-service/
WORKDIR /app/rules-service
RUN npm install --omit=dev --no-audit --no-fund
COPY rules-service/ ./
ENV RULES_PORT=6001
EXPOSE 6001
USER node
CMD ["node", "index.js"]

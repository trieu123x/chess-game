FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV RULES_PORT=6001
EXPOSE 6001
USER node
CMD ["node", "index.js"]

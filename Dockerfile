FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3050
CMD ["node", "server.js"]

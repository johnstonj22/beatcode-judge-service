FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY judge-server.js ./

ENV NODE_ENV=production

# Not strictly required by Railway, but fine to include
EXPOSE 8080

CMD ["node", "judge-server.js"]
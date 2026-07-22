FROM node:20-alpine

WORKDIR /app

# Only the backend's one dependency (pg) — no need to pull in Vite/React for this image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"]

# API de INSAWEB (Node + Express). La configuración se pasa por variables de entorno (ver .env.example).
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY plantillas ./plantillas

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/api/salud" > /dev/null || exit 1

CMD ["node", "src/server.js"]

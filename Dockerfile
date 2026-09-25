# API de INSAWEB (Node + Express). La configuración se pasa por variables de entorno (ver .env.example).
FROM node:20-alpine

# Instalar tzdata para que las fechas de auditoría y reportes usen la zona horaria local (America/Caracas)
RUN apk add --no-cache tzdata

WORKDIR /app
ENV NODE_ENV=production \
    TZ=America/Caracas \
    PORT=3001 \
    HOST=0.0.0.0 \
    DB_HOST=10.10.0.4 \
    DB_PORT=3306 \
    DB_NAME=o0002a2026 \
    DB_PREFIX=o0002a \
    HIST_DESDE=2003 \
    TRUST_PROXY=true

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY plantillas ./plantillas

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/api/salud" > /dev/null || exit 1

CMD ["node", "src/server.js"]

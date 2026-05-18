# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Instala só dependências de produção
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia código (cache-lote.json e .env são excluídos via .dockerignore)
COPY config.js index.js ./
COPY src ./src

# Cria diretório de dados persistente e ajusta owner pro user "node"
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "index.js"]

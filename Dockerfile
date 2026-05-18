FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node ./ ./

USER node

EXPOSE 3002

CMD ["node", "index.js"]

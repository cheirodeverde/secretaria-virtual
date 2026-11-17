# Imagem do sistema (usada pelo docker-compose.yml)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY templates ./templates
COPY scripts ./scripts
# Banco SQLite em /app/data: monte um volume/disco persistente nesta pasta
# (Railway: aba Volumes · docker-compose/Portainer: já configurado). Sem volume, os dados somem a cada deploy.
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

FROM node:20-alpine

WORKDIR /app

# 仅生产依赖
COPY package*.json ./
RUN npm install --omit=dev

# 应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]

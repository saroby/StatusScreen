FROM node:26-alpine

WORKDIR /app
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY worker ./worker
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV STATUSSCREEN_DB=/app/data/statusscreen.db
EXPOSE 3000 8080

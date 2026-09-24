# Runner image: node + deps only. src/ and the pinned Strike Canopy clone are
# bind-mounted (compose), so a re-pin or code edit needs no rebuild.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
ENV NODE_ENV=production
CMD ["sleep", "infinity"]

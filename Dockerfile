FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/live-service/package*.json ./
RUN npm install --omit=dev

COPY services/live-service/src  ./src
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src          ./src
COPY --from=builder /app/package.json ./

RUN groupadd --system appgroup && \
    useradd  --system -g appgroup appuser && \
    chown -R appuser:appgroup /app
USER appuser

EXPOSE 3003
EXPOSE 10000-10100/udp

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=20s \
  CMD node -e "const http=require('http');const port=process.env.PORT||3003;const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:2000},(r)=>process.exit(r.statusCode===200?0:1));req.on('error',()=>process.exit(1));"

CMD ["node", "src/index.js"]

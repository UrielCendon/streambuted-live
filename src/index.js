"use strict";

require("dotenv").config();

const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const logger = require("./logger");
const { createWorkers } = require("./sfu/workerPool");
const roomManager = require("./rooms/roomManager");
const signalingHandler = require("./signaling/signalingHandler");
const roomsRouter = require("./routes/rooms.routes");
const { authMiddleware } = require("./auth/authMiddleware");

function getAllowedOrigins() {
  const rawOrigins = process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*";
  return rawOrigins.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function isOriginAllowed(origin, allowedOrigins) {
  return !origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}

function corsMiddleware(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (isOriginAllowed(origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin || allowedOrigins[0] || "*");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-Id");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  };
}

async function main() {
  await createWorkers();
  logger.info("mediasoup workers ready");

  const app = express();
  const server = http.createServer(app);
  const allowedOrigins = getAllowedOrigins();

  app.use(corsMiddleware(allowedOrigins));
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "live-service" }));
  app.use("/api/v1/live", authMiddleware, roomsRouter);

  const io = new Server(server, {
    path: process.env.SOCKET_IO_PATH || "/socket.io",
    cors: {
      origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("AUTH_REQUIRED"));
    }

    try {
      socket.user = await require("./auth/jwtValidator").validateToken(token);
      socket.data.authToken = token;
      next();
    } catch (err) {
      logger.warn(`Socket auth failed: ${err.message}`);
      next(new Error("AUTH_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    logger.info(`Socket connected  user=${socket.user.userId}  role=${socket.user.role}`);
    signalingHandler(io, socket, roomManager);
  });

  const PORT = process.env.PORT || 3003;
  server.listen(PORT, () => {
    logger.info(`live-service listening on :${PORT}`);
  });
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.stack}`);
  process.exit(1);
});

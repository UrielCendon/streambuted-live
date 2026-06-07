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
const {
  liveOpenApiDocument,
  renderSwaggerUiHtml,
  renderSwaggerUiInitializer,
} = require("./openapi");

function getAllowedOrigins() {
  const rawOrigins = process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "";
  const origins = rawOrigins.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes("*")) {
    throw new Error("CORS_ALLOWED_ORIGINS must define explicit origins and cannot include '*'.");
  }
  return origins;
}

function isOriginAllowed(origin, allowedOrigins) {
  return !origin || allowedOrigins.includes(origin);
}

function corsMiddleware(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (isOriginAllowed(origin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin || allowedOrigins[0]);
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
  app.get("/api/v1/live/openapi.json", (_req, res) => res.json(liveOpenApiDocument));
  app.get("/api/v1/live/docs", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(renderSwaggerUiHtml("StreamButed Live Service", "/api/v1/live/docs/swagger-ui.js"));
  });
  app.get("/api/v1/live/docs/swagger-ui.js", (_req, res) => {
    res
      .status(200)
      .type("application/javascript")
      .send(renderSwaggerUiInitializer("/api/v1/live/openapi.json"));
  });
  app.use("/api/v1/live", authMiddleware, roomsRouter);

  const io = new Server(server, {
    path: process.env.SOCKET_IO_PATH || "/socket.io",
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      const authError = new Error("Tu sesion expiro. Inicia sesion nuevamente.");
      authError.data = {
        error: "AUTH_REQUIRED",
        message: "Tu sesion expiro. Inicia sesion nuevamente."
      };
      return next(authError);
    }

    try {
      socket.user = await require("./auth/jwtValidator").validateToken(token);
      socket.data.authToken = token;
      next();
    } catch (err) {
      logger.warn(`Socket auth failed: ${err.message}`);
      const authError = new Error("Tu sesion expiro. Inicia sesion nuevamente.");
      authError.data = {
        error: "AUTH_INVALID",
        message: "Tu sesion expiro. Inicia sesion nuevamente."
      };
      next(authError);
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

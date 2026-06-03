"use strict";

const { validateToken } = require("./jwtValidator");
const logger = require("../logger");
const { sendError } = require("../http/errorResponse");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return sendError(res, 401, "AUTH_REQUIRED", "Tu sesion expiro. Inicia sesion nuevamente.");
  }

  try {
    req.user = await validateToken(token);
    req.authToken = token;
    next();
  } catch (err) {
    logger.warn(`Auth failed: ${err.message}`);
    if (err.statusCode === 403 && err.error === "AccountBannedException") {
      return sendError(
        res,
        403,
        "AccountBannedException",
        err.message,
        {
          code: err.code || "ACCOUNT_BANNED",
          banType: err.banType,
          bannedUntil: err.bannedUntil ?? null,
          remainingSeconds: err.remainingSeconds,
        }
      );
    }

    if (err.statusCode === 503) {
      return sendError(
        res,
        503,
        "ServiceUnavailable",
        "Esta funcion no esta disponible en este momento. Intenta de nuevo mas tarde."
      );
    }

    sendError(res, 401, "AUTH_INVALID", "Tu sesion expiro. Inicia sesion nuevamente.");
  }
}

module.exports = { authMiddleware };

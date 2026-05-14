"use strict";

const { validateToken } = require("./jwtValidator");
const logger = require("../logger");
const { sendError } = require("../http/errorResponse");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return sendError(res, 401, "AUTH_REQUIRED", "Bearer token missing");
  }

  try {
    req.user = await validateToken(token);
    req.authToken = token;
    next();
  } catch (err) {
    logger.warn(`Auth failed: ${err.message}`);
    sendError(res, 401, "AUTH_INVALID", "Token is invalid or expired");
  }
}

module.exports = { authMiddleware };

"use strict";

const jwt      = require("jsonwebtoken");
const jwksRsa  = require("jwks-rsa");
const logger   = require("../logger");

const ACCOUNT_BANNED_MESSAGE = "La cuenta se encuentra suspendida.";
const SESSION_UNAVAILABLE_MESSAGE = "Esta funcion no esta disponible en este momento. Intenta de nuevo mas tarde.";
const SESSION_EXPIRED_MESSAGE = "Tu sesion expiro. Inicia sesion nuevamente.";
const SESSION_INVALID_MESSAGE = "No se pudo validar tu sesion. Inicia sesion nuevamente.";
const identityBaseUrl = (
  process.env.IDENTITY_BASE_URL
  || process.env.JWT_ISSUER
  || "http://identity-service:8081"
).replace(/\/$/, "");

const jwksClient = jwksRsa({
  jwksUri              : process.env.JWT_JWKS_URL
                         || "http://identity-service:8081/api/v1/auth/.well-known/jwks.json",
  cache                : true,
  cacheMaxEntries      : 5,
  cacheMaxAge          : 10 * 60 * 1000,
  rateLimit            : true,
  jwksRequestsPerMinute: 10,
});

function getPublicKey(header, callback) {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      logger.warn(`JWKS key fetch failed: ${err.message}`);
      return callback(err);
    }
    callback(null, key.getPublicKey());
  });
}

function validateToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getPublicKey,
      {
        algorithms: ["RS256"],
        issuer    : process.env.JWT_ISSUER || "http://identity-service:8081",
        audience  : process.env.JWT_AUDIENCE || "streambuted-api",
      },
      (err, decoded) => {
        if (err) return reject(new Error(SESSION_EXPIRED_MESSAGE));

        const userId = decoded.sub;
        const role   = decoded.role || decoded.authorities?.[0] || "LISTENER";
        const name   = decoded.username || decoded.preferred_username || decoded.name || decoded.given_name || decoded.email || userId;

        if (!userId) return reject(new Error(SESSION_INVALID_MESSAGE));

        validateAccountState(token)
          .then(() => resolve({ userId, role, name }))
          .catch(reject);
      }
    );
  });
}

async function validateAccountState(token) {
  let response;
  try {
    response = await fetch(`${identityBaseUrl}/api/v1/auth/validate`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    logger.error(`Identity account validation failed: ${error.message}`);
    const serviceError = new Error(SESSION_UNAVAILABLE_MESSAGE);
    serviceError.statusCode = 503;
    serviceError.error = "ServiceUnavailable";
    throw serviceError;
  }

  const payload = await parseJsonSafely(response);
  if (response.ok) {
    return;
  }

  if (response.status === 403 && isAccountBannedPayload(payload)) {
    const bannedError = new Error(payload.message || ACCOUNT_BANNED_MESSAGE);
    bannedError.statusCode = 403;
    bannedError.error = "AccountBannedException";
    bannedError.code = payload.code || "ACCOUNT_BANNED";
    bannedError.banType = payload.banType;
    bannedError.bannedUntil = payload.bannedUntil ?? null;
    bannedError.remainingSeconds = payload.remainingSeconds;
    throw bannedError;
  }

  if (response.status === 401) {
    const authError = new Error(SESSION_EXPIRED_MESSAGE);
    authError.statusCode = 401;
    authError.error = "Unauthorized";
    throw authError;
  }

  const serviceError = new Error(SESSION_UNAVAILABLE_MESSAGE);
  serviceError.statusCode = 503;
  serviceError.error = "ServiceUnavailable";
  throw serviceError;
}

async function parseJsonSafely(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function isAccountBannedPayload(payload) {
  return payload.code === "ACCOUNT_BANNED" || payload.error === "AccountBannedException";
}

module.exports = { validateToken };

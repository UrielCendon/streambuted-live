"use strict";

const jwt      = require("jsonwebtoken");
const jwksRsa  = require("jwks-rsa");
const logger   = require("../logger");

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
        if (err) return reject(new Error(`JWT invalid: ${err.message}`));

        const userId = decoded.sub;
        const role   = decoded.role || decoded.authorities?.[0] || "LISTENER";
        const name   = decoded.username || decoded.preferred_username || decoded.name || decoded.given_name || decoded.email || userId;

        if (!userId) return reject(new Error("Token missing 'sub' claim"));
        resolve({ userId, role, name });
      }
    );
  });
}

module.exports = { validateToken };

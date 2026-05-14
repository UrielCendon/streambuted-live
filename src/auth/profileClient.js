"use strict";

const logger = require("../logger");

const IDENTITY_BASE_URL = process.env.IDENTITY_BASE_URL || "http://identity-service:8081";

async function getAuthenticatedUsername(token) {
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`${IDENTITY_BASE_URL}/api/v1/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.warn(`Identity profile lookup failed: HTTP ${response.status}`);
      return null;
    }

    const profile = await response.json();
    return typeof profile.username === "string" && profile.username.trim()
      ? profile.username.trim()
      : null;
  } catch (err) {
    logger.warn(`Identity profile lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = { getAuthenticatedUsername };

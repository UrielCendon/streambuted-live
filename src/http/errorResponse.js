"use strict";

function sendError(res, statusCode, error, message, extra = {}) {
  return res.status(statusCode).json({
    error,
    ...extra,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { sendError };

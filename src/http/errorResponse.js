"use strict";

function sendError(res, statusCode, error, message) {
  return res.status(statusCode).json({
    error,
    message,
    statusCode,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { sendError };

"use strict";

const { createLogger, format, transports } = require("winston");

const { combine, timestamp, printf, colorize } = format;

const jsonFormat = printf(({ level, message, timestamp, ...meta }) => {
  return JSON.stringify({
    timestamp,
    level: level.toUpperCase(),
    service: "live-service",
    message,
    ...meta,
  });
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp(), jsonFormat),
  transports: [
    new transports.Console({

      format:
        process.env.NODE_ENV === "development"
          ? combine(colorize(), timestamp(), printf(({ level, message }) => `[${level}] ${message}`))
          : combine(timestamp(), jsonFormat),
    }),
  ],
});

module.exports = logger;

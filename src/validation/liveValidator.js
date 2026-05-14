"use strict";

const VALID_DIRECTIONS = new Set(["send", "recv"]);
const VALID_KINDS = new Set(["audio", "video"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTitle(title) {
  if (!isNonEmptyString(title)) {
    return null;
  }

  return title.trim();
}

function validateRoomId(roomId) {
  return isNonEmptyString(roomId) ? roomId.trim() : null;
}

function validateDirection(direction) {
  return VALID_DIRECTIONS.has(direction) ? direction : null;
}

function validateKind(kind) {
  return VALID_KINDS.has(kind) ? kind : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  isObject,
  normalizeTitle,
  validateDirection,
  validateKind,
  validateRoomId,
};

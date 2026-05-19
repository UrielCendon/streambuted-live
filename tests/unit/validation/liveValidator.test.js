"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isObject,
  normalizeTitle,
  validateDirection,
  validateKind,
  validateRoomId,
} = require("../../../src/validation/liveValidator");

test("live validators normalize accepted values used by REST and signaling flows", () => {
  const normalizedTitle = normalizeTitle("  Friday Live  ");
  const roomId = validateRoomId("  room-1  ");
  const sendDirection = validateDirection("send");
  const audioKind = validateKind("audio");
  const objectResult = isObject({ codec: "opus" });

  assert.equal(normalizedTitle, "Friday Live");
  assert.equal(roomId, "room-1");
  assert.equal(sendDirection, "send");
  assert.equal(audioKind, "audio");
  assert.equal(objectResult, true);
});

test("live validators reject empty or unsupported payload values", () => {
  const emptyTitle = normalizeTitle("   ");
  const emptyRoomId = validateRoomId("");
  const invalidDirection = validateDirection("publish");
  const invalidKind = validateKind("screen");
  const arrayResult = isObject([]);

  assert.equal(emptyTitle, null);
  assert.equal(emptyRoomId, null);
  assert.equal(invalidDirection, null);
  assert.equal(invalidKind, null);
  assert.equal(arrayResult, false);
});

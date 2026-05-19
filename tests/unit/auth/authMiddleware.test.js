"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const authMiddlewarePath = require.resolve("../../../src/auth/authMiddleware");
const jwtValidatorPath = require.resolve("../../../src/auth/jwtValidator");
const loggerPath = require.resolve("../../../src/logger");

function loadAuthMiddleware(validateToken) {
  delete require.cache[authMiddlewarePath];
  require.cache[jwtValidatorPath] = {
    id: jwtValidatorPath,
    filename: jwtValidatorPath,
    loaded: true,
    exports: { validateToken },
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn() {} },
  };

  return require("../../../src/auth/authMiddleware").authMiddleware;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("authMiddleware accepts a valid bearer token and exposes the authenticated user", async () => {
  const authenticatedUser = { userId: "artist-1", role: "ARTIST", name: "Ada" };
  const authMiddleware = loadAuthMiddleware(async () => authenticatedUser);
  const req = { headers: { authorization: "Bearer valid-token" } };
  const res = createResponse();
  let nextCalls = 0;

  await authMiddleware(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.deepEqual(req.user, authenticatedUser);
  assert.equal(req.authToken, "valid-token");
});

test("authMiddleware rejects requests without a bearer token", async () => {
  const authMiddleware = loadAuthMiddleware(async () => ({ userId: "artist-1" }));
  const req = { headers: {} };
  const res = createResponse();
  let nextCalls = 0;

  await authMiddleware(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "AUTH_REQUIRED");
});

test("authMiddleware returns a controlled 401 when token validation fails", async () => {
  const authMiddleware = loadAuthMiddleware(async () => {
    throw new Error("expired");
  });
  const req = { headers: { authorization: "Bearer expired-token" } };
  const res = createResponse();
  let nextCalls = 0;

  await authMiddleware(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "AUTH_INVALID");
});

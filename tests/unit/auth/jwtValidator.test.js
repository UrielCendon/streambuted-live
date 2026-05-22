"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const validatorPath = require.resolve("../../../src/auth/jwtValidator");

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    async json() {
      return payload;
    },
  };
}

function loadValidator({ verifyImplementation, fetchImplementation }) {
  const originalLoad = Module._load;
  delete require.cache[validatorPath];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "jsonwebtoken") {
      return { verify: verifyImplementation };
    }

    if (request === "jwks-rsa") {
      return () => ({
        getSigningKey(_kid, callback) {
          callback(null, { getPublicKey: () => "public-key" });
        },
      });
    }

    if (request === "../logger" && parent?.filename === validatorPath) {
      return { warn() {}, error() {} };
    }

    return originalLoad(request, parent, isMain);
  };

  global.fetch = fetchImplementation;

  try {
    return require("../../../src/auth/jwtValidator").validateToken;
  } finally {
    Module._load = originalLoad;
  }
}

test("validateToken accepts a token when Identity confirms the account is active", async () => {
  const validateToken = loadValidator({
    verifyImplementation(_token, _getPublicKey, _options, callback) {
      callback(null, {
        sub: "artist-1",
        role: "ARTIST",
        username: "Ada",
      });
    },
    fetchImplementation: async (url, options) => {
      assert.equal(url, "http://identity-service:8081/api/v1/auth/validate");
      assert.equal(options.headers.Authorization, "Bearer valid-token");
      return createJsonResponse(200, {
        userId: "artist-1",
        role: "artist",
        email: "ada@example.com",
        isActive: true,
      });
    },
  });

  const user = await validateToken("valid-token");

  assert.deepEqual(user, {
    userId: "artist-1",
    role: "ARTIST",
    name: "Ada",
  });
});

test("validateToken rejects suspended accounts reported by Identity", async () => {
  const validateToken = loadValidator({
    verifyImplementation(_token, _getPublicKey, _options, callback) {
      callback(null, {
        sub: "artist-1",
        role: "ARTIST",
        username: "Ada",
      });
    },
    fetchImplementation: async () => createJsonResponse(403, {
      error: "AccountBannedException",
      code: "ACCOUNT_BANNED",
      message: "La cuenta se encuentra suspendida.",
      banType: "TEMPORARY",
      bannedUntil: "2026-05-22T13:00:00Z",
      remainingSeconds: 600,
    }),
  });

  await assert.rejects(
    () => validateToken("banned-token"),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.error, "AccountBannedException");
      assert.equal(error.code, "ACCOUNT_BANNED");
      assert.equal(error.banType, "TEMPORARY");
      return true;
    }
  );
});

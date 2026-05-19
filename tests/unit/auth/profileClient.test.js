"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const profileClientPath = require.resolve("../../../src/auth/profileClient");
const loggerPath = require.resolve("../../../src/logger");

function loadProfileClient() {
  delete require.cache[profileClientPath];
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { warn() {} },
  };

  return require("../../../src/auth/profileClient");
}

test("getAuthenticatedUsername returns null when there is no token", async () => {
  const { getAuthenticatedUsername } = loadProfileClient();

  const username = await getAuthenticatedUsername(null);

  assert.equal(username, null);
});

test("getAuthenticatedUsername returns the trimmed username from Identity", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ username: "  stage-name  " }),
  });
  const { getAuthenticatedUsername } = loadProfileClient();

  const username = await getAuthenticatedUsername("token");

  assert.equal(username, "stage-name");
  global.fetch = originalFetch;
});

test("getAuthenticatedUsername returns null when Identity rejects the profile request", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  const { getAuthenticatedUsername } = loadProfileClient();

  const username = await getAuthenticatedUsername("token");

  assert.equal(username, null);
  global.fetch = originalFetch;
});

"use strict";

const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");

const routerPath = require.resolve("../../../src/routes/rooms.routes");
const roomManagerPath = require.resolve("../../../src/rooms/roomManager");
const profileClientPath = require.resolve("../../../src/auth/profileClient");
const loggerPath = require.resolve("../../../src/logger");

function createRoom(overrides = {}) {
  return {
    id: "room-1",
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    status: "LIVE",
    listeners: 2,
    toJSON() {
      return {
        id: this.id,
        artistId: this.artistId,
        artistName: this.artistName,
        title: this.title,
        status: this.status,
        listeners: this.listeners,
      };
    },
    ...overrides,
  };
}

function loadRouter({ roomManager, getAuthenticatedUsername = async () => "identity-name" }) {
  delete require.cache[routerPath];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "express") {
      return { Router: createExpressRouter };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  require.cache[roomManagerPath] = {
    id: roomManagerPath,
    filename: roomManagerPath,
    loaded: true,
    exports: roomManager,
  };
  require.cache[profileClientPath] = {
    id: profileClientPath,
    filename: profileClientPath,
    loaded: true,
    exports: { getAuthenticatedUsername },
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { error() {}, info() {}, warn() {} },
  };

  const router = require("../../../src/routes/rooms.routes");
  Module._load = originalLoad;
  return router;
}

function createExpressRouter() {
  return {
    stack: [],
    get(path, handle) {
      this.stack.push({
        route: {
          path,
          methods: { get: true },
          stack: [{ handle }],
        },
      });
    },
    post(path, handle) {
      this.stack.push({
        route: {
          path,
          methods: { post: true },
          stack: [{ handle }],
        },
      });
    },
  };
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

async function callRoute(router, method, path, req) {
  const layer = router.stack.find((candidate) => (
    candidate.route
    && candidate.route.path === path
    && candidate.route.methods[method]
  ));
  const res = createResponse();

  await layer.route.stack[0].handle(req, res);

  return res;
}

test("GET /rooms returns live rooms with a total count", async () => {
  const room = createRoom();
  const router = loadRouter({
    roomManager: {
      getLiveRooms: () => [room],
    },
  });

  const res = await callRoute(router, "get", "/rooms", {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { data: [room.toJSON()], total: 1 });
});

test("GET /rooms/:roomId returns validation, not-found and success responses", async () => {
  const room = createRoom();
  const router = loadRouter({
    roomManager: {
      getRoom: (roomId) => (roomId === "room-1" ? room : undefined),
    },
  });

  const invalidResponse = await callRoute(router, "get", "/rooms/:roomId", { params: { roomId: " " } });
  const missingResponse = await callRoute(router, "get", "/rooms/:roomId", { params: { roomId: "missing" } });
  const successResponse = await callRoute(router, "get", "/rooms/:roomId", { params: { roomId: "room-1" } });

  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.body.error, "VALIDATION_ERROR");
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missingResponse.body.error, "ROOM_NOT_FOUND");
  assert.equal(successResponse.statusCode, 200);
  assert.deepEqual(successResponse.body, room.toJSON());
});

test("POST /rooms creates rooms only for artists with valid titles", async () => {
  const createdRoom = createRoom({ artistName: "identity-name", title: "Friday Live" });
  const createRoomCalls = [];
  const router = loadRouter({
    roomManager: {
      createRoom: async (payload) => {
        createRoomCalls.push(payload);
        return createdRoom;
      },
    },
  });

  const forbiddenResponse = await callRoute(router, "post", "/rooms", {
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
    body: { title: "Friday Live" },
  });
  const invalidResponse = await callRoute(router, "post", "/rooms", {
    user: { userId: "artist-1", role: "ARTIST", name: "Fallback Name" },
    body: { title: " " },
  });
  const successResponse = await callRoute(router, "post", "/rooms", {
    user: { userId: "artist-1", role: "ROLE_ARTIST", name: "Fallback Name" },
    authToken: "token",
    body: { title: "  Friday Live  " },
  });

  assert.equal(forbiddenResponse.statusCode, 403);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(successResponse.statusCode, 201);
  assert.deepEqual(createRoomCalls, [{
    artistId: "artist-1",
    artistName: "identity-name",
    title: "Friday Live",
  }]);
});

test("POST /rooms returns a controlled internal error when room creation fails", async () => {
  const router = loadRouter({
    roomManager: {
      createRoom: async () => {
        throw new Error("router unavailable");
      },
    },
  });

  const res = await callRoute(router, "post", "/rooms", {
    user: { userId: "artist-1", role: "ARTIST", name: "Fallback Name" },
    authToken: "token",
    body: { title: "Friday Live" },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "INTERNAL_ERROR");
});

"use strict";

const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");

const managerPath = require.resolve("../../../src/rooms/roomManager");
const workerPoolPath = require.resolve("../../../src/sfu/workerPool");
const loggerPath = require.resolve("../../../src/logger");

function loadRoomManager() {
  delete require.cache[managerPath];
  delete require.cache[require.resolve("../../../src/rooms/Room")];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "uuid") {
      return { v4: () => "room-1" };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  require.cache[workerPoolPath] = {
    id: workerPoolPath,
    filename: workerPoolPath,
    loaded: true,
    exports: {
      createRouter: async () => ({
        rtpCapabilities: { codecs: [] },
        close() {
          this.closed = true;
        },
      }),
    },
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { info() {}, warn() {}, error() {} },
  };

  const roomManager = require("../../../src/rooms/roomManager");
  Module._load = originalLoad;
  return roomManager;
}

test("RoomManager returns an existing active room when an artist creates twice", async () => {
  const roomManager = loadRoomManager();

  const firstRoom = await roomManager.createRoom({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "First Concert",
  });
  const secondRoom = await roomManager.createRoom({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Second Concert",
  });

  assert.equal(secondRoom.id, firstRoom.id);
  assert.equal(secondRoom.title, "First Concert");
});

test("RoomManager lists only live rooms and removes rooms after closing them", async () => {
  const roomManager = loadRoomManager();
  const room = await roomManager.createRoom({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "First Concert",
  });
  room.status = "LIVE";

  const liveRooms = roomManager.getLiveRooms();
  await roomManager.closeRoom(room.id);

  assert.deepEqual(liveRooms.map((liveRoom) => liveRoom.id), [room.id]);
  assert.equal(roomManager.getRoom(room.id), undefined);
});

test("RoomManager throws when a requested room does not exist", () => {
  const roomManager = loadRoomManager();

  assert.throws(() => roomManager.getOrThrow("missing-room"), /Room missing-room not found/);
});

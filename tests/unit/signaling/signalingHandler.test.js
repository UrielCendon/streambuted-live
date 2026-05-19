"use strict";

const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");

const signalingHandlerPath = require.resolve("../../../src/signaling/signalingHandler");
const profileClientPath = require.resolve("../../../src/auth/profileClient");
const loggerPath = require.resolve("../../../src/logger");

function loadSignalingHandler(getAuthenticatedUsername = async () => "identity-name") {
  delete require.cache[signalingHandlerPath];
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
    exports: { info() {}, warn() {}, error() {} },
  };

  return require("../../../src/signaling/signalingHandler");
}

class FakeSocket {
  constructor({ id = "socket-1", user, authToken = "token" }) {
    this.id = id;
    this.user = user;
    this.data = { authToken };
    this.rooms = new Set();
    this.handlers = new Map();
    this.emitted = [];
    this.roomEmits = [];
    this.joinedRooms = [];
    this.leftRooms = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, payload) {
    this.emitted.push({ event, payload });
  }

  to(roomId) {
    return {
      emit: (event, payload) => {
        this.roomEmits.push({ roomId, event, payload });
      },
    };
  }

  join(roomId) {
    this.rooms.add(roomId);
    this.joinedRooms.push(roomId);
  }

  leave(roomId) {
    this.rooms.delete(roomId);
    this.leftRooms.push(roomId);
  }

  async trigger(event, payload) {
    await this.handlers.get(event)(payload);
  }
}

class FakeTransport extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.iceParameters = { usernameFragment: "ufrag" };
    this.iceCandidates = [];
    this.dtlsParameters = { role: "auto" };
    this.sctpParameters = {};
    this.connectedWith = null;
  }

  async connect({ dtlsParameters }) {
    this.connectedWith = dtlsParameters;
  }
}

class FakeConsumer extends EventEmitter {
  constructor(id, producerId) {
    super();
    this.id = id;
    this.producerId = producerId;
    this.kind = "audio";
    this.rtpParameters = { codecs: [] };
    this.appData = {};
    this.resumeCalls = 0;
  }

  async resume() {
    this.resumeCalls += 1;
  }
}

function createIo() {
  const broadcasts = [];
  return {
    broadcasts,
    to(roomId) {
      return {
        emit(event, payload) {
          broadcasts.push({ roomId, event, payload });
        },
      };
    },
  };
}

function createRoom(overrides = {}) {
  const room = {
    id: "room-1",
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    status: "CREATED",
    listenerCount: 0,
    producerIds: ["producer-1"],
    router: { rtpCapabilities: { codecs: [] } },
    _transports: new Map(),
    _consumers: new Map(),
    listeners: new Set(),
    createWebRtcTransportCalls: [],
    closePeerResourcesCalls: [],
    addListener(socketId) {
      this.listeners.add(socketId);
      this.listenerCount = this.listeners.size;
    },
    removeListener(socketId) {
      this.listeners.delete(socketId);
      this.listenerCount = this.listeners.size;
    },
    hasListener(socketId) {
      return this.listeners.has(socketId);
    },
    ownsConsumer(socketId, consumerId) {
      return this.consumerOwners?.get(consumerId) === socketId;
    },
    closePeerResources(socketId, directions) {
      this.closePeerResourcesCalls.push({ socketId, directions });
    },
    async createWebRtcTransport(socketId, direction) {
      this.createWebRtcTransportCalls.push({ socketId, direction });
      const transport = new FakeTransport(`transport-${direction}`);
      this._transports.set(`${socketId}:${direction}`, transport);
      return transport;
    },
    async createProducer(_socketId, params) {
      this.status = "LIVE";
      return { id: "producer-1", kind: params.kind };
    },
    async createConsumer(socketId, producerId) {
      const consumer = new FakeConsumer("consumer-1", producerId);
      this._consumers.set(consumer.id, consumer);
      this.consumerOwners = new Map([[consumer.id, socketId]]);
      return consumer;
    },
    ...overrides,
  };
  return room;
}

test("signaling live:create creates a room for artists and rejects listeners", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom();
  const createRoomCalls = [];
  const roomManager = {
    createRoom: async (payload) => {
      createRoomCalls.push(payload);
      return room;
    },
  };
  const artistSocket = new FakeSocket({
    user: { userId: "artist-1", role: "ROLE_ARTIST", name: "Fallback Name" },
  });
  const listenerSocket = new FakeSocket({
    id: "listener-socket",
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
  });

  signalingHandler(io, artistSocket, roomManager);
  signalingHandler(io, listenerSocket, roomManager);
  await artistSocket.trigger("live:create", { title: "  Friday Live  " });
  await listenerSocket.trigger("live:create", { title: "Friday Live" });

  assert.deepEqual(createRoomCalls, [{
    artistId: "artist-1",
    artistName: "identity-name",
    title: "Friday Live",
  }]);
  assert.deepEqual(artistSocket.joinedRooms, ["room-1"]);
  assert.deepEqual(artistSocket.emitted.map((item) => item.event), ["live:listenerCount", "live:created"]);
  assert.equal(listenerSocket.emitted[0].event, "live:create:error");
});

test("signaling live:join moves listeners into the target room and announces producer ids", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const previousRoom = createRoom({ id: "previous-room" });
  const targetRoom = createRoom({ status: "LIVE" });
  const socket = new FakeSocket({
    id: "listener-socket",
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
  });
  socket.data.roomId = "previous-room";
  previousRoom.addListener(socket.id);
  const roomManager = {
    getRoom: (roomId) => (roomId === "previous-room" ? previousRoom : targetRoom),
    getOrThrow: (roomId) => {
      if (roomId === "room-1") return targetRoom;
      throw new Error("missing room");
    },
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:join", { roomId: "room-1" });

  assert.deepEqual(socket.leftRooms, ["previous-room"]);
  assert.deepEqual(socket.joinedRooms, ["room-1"]);
  assert.equal(targetRoom.hasListener(socket.id), true);
  assert.equal(socket.emitted[0].event, "live:joined");
  assert.deepEqual(socket.emitted[0].payload.producerIds, ["producer-1"]);
  assert.deepEqual(previousRoom.closePeerResourcesCalls, [{ socketId: "listener-socket", directions: ["recv"] }]);
});

test("signaling transport flow creates and connects authorized transports", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom();
  const socket = new FakeSocket({
    user: { userId: "artist-1", role: "ARTIST", name: "Stage Name" },
  });
  const roomManager = {
    getOrThrow: () => room,
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:createTransport", { roomId: "room-1", direction: "send" });
  await socket.trigger("live:connectTransport", {
    roomId: "room-1",
    transportId: "transport-send",
    direction: "send",
    dtlsParameters: { fingerprints: [] },
  });

  assert.deepEqual(room.createWebRtcTransportCalls, [{ socketId: "socket-1", direction: "send" }]);
  assert.equal(socket.emitted[0].event, "live:transportCreated");
  assert.equal(socket.emitted[1].event, "live:transportConnected");
  assert.deepEqual(room._transports.get("socket-1:send").connectedWith, { fingerprints: [] });
});

test("signaling live:produce emits the producer id and notifies room listeners", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom();
  const socket = new FakeSocket({
    user: { userId: "artist-1", role: "ARTIST", name: "Stage Name" },
  });
  const roomManager = {
    getOrThrow: () => room,
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:produce", {
    roomId: "room-1",
    kind: "audio",
    rtpParameters: { codecs: [] },
    appData: { track: "main" },
  });

  assert.equal(socket.emitted[0].event, "live:produced");
  assert.deepEqual(socket.emitted[0].payload, { producerId: "producer-1" });
  assert.deepEqual(socket.roomEmits, [{
    roomId: "room-1",
    event: "live:newProducer",
    payload: { producerId: "producer-1", kind: "audio" },
  }]);
});

test("signaling live:consume and live:resumeConsumer protect listener ownership", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom({ status: "LIVE" });
  room.addListener("listener-socket");
  const socket = new FakeSocket({
    id: "listener-socket",
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
  });
  socket.rooms.add("room-1");
  const roomManager = {
    getOrThrow: () => room,
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:consume", {
    roomId: "room-1",
    producerId: "producer-1",
    rtpCapabilities: { codecs: [] },
  });
  await socket.trigger("live:resumeConsumer", { roomId: "room-1", consumerId: "consumer-1" });

  assert.equal(socket.emitted[0].event, "live:consumed");
  assert.equal(socket.emitted[0].payload.consumerId, "consumer-1");
  assert.equal(room._consumers.get("consumer-1").resumeCalls, 1);
});

test("signaling live:leave removes listener resources and broadcasts the new count", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom({ status: "LIVE" });
  room.addListener("listener-socket");
  const socket = new FakeSocket({
    id: "listener-socket",
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
  });
  socket.data.roomId = "room-1";
  const roomManager = {
    getRoom: () => room,
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:leave", {});

  assert.equal(room.hasListener("listener-socket"), false);
  assert.deepEqual(socket.leftRooms, ["room-1"]);
  assert.deepEqual(room.closePeerResourcesCalls, [{ socketId: "listener-socket", directions: ["recv"] }]);
  assert.deepEqual(io.broadcasts, [{
    roomId: "room-1",
    event: "live:listenerCount",
    payload: { roomId: "room-1", count: 0 },
  }]);
});

test("signaling live:end closes only rooms owned by the artist", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const room = createRoom();
  const closedRooms = [];
  const socket = new FakeSocket({
    user: { userId: "artist-1", role: "ARTIST", name: "Stage Name" },
  });
  socket.data.roomId = "room-1";
  socket.data.isArtist = true;
  const roomManager = {
    getRoom: () => room,
    closeRoom: async (roomId) => {
      closedRooms.push(roomId);
    },
  };

  signalingHandler(io, socket, roomManager);
  await socket.trigger("live:end", { roomId: "room-1" });

  assert.deepEqual(closedRooms, ["room-1"]);
  assert.deepEqual(socket.leftRooms, ["room-1"]);
  assert.deepEqual(io.broadcasts, [{
    roomId: "room-1",
    event: "live:ended",
    payload: { roomId: "room-1", reason: "ARTIST_ENDED" },
  }]);
});

test("signaling disconnect closes artist rooms and cleans listener resources", async () => {
  const signalingHandler = loadSignalingHandler();
  const io = createIo();
  const artistRoom = createRoom();
  const listenerRoom = createRoom({ status: "LIVE" });
  listenerRoom.addListener("listener-socket");
  const closedRooms = [];
  const artistSocket = new FakeSocket({
    user: { userId: "artist-1", role: "ARTIST", name: "Stage Name" },
  });
  artistSocket.data.roomId = "room-1";
  artistSocket.data.isArtist = true;
  const listenerSocket = new FakeSocket({
    id: "listener-socket",
    user: { userId: "listener-1", role: "LISTENER", name: "Listener" },
  });
  listenerSocket.data.roomId = "room-1";
  const roomManager = {
    getRoom: () => artistRoom,
    closeRoom: async (roomId) => {
      closedRooms.push(roomId);
    },
  };
  const listenerRoomManager = {
    getRoom: () => listenerRoom,
  };

  signalingHandler(io, artistSocket, roomManager);
  signalingHandler(io, listenerSocket, listenerRoomManager);
  await artistSocket.trigger("disconnect", "transport close");
  await listenerSocket.trigger("disconnect", "client namespace disconnect");

  assert.deepEqual(closedRooms, ["room-1"]);
  assert.equal(listenerRoom.hasListener("listener-socket"), false);
  assert.deepEqual(listenerRoom.closePeerResourcesCalls, [{ socketId: "listener-socket", directions: ["recv"] }]);
});

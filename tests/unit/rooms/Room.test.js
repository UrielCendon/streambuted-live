"use strict";

const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");

const roomPath = require.resolve("../../../src/rooms/Room");
const loggerPath = require.resolve("../../../src/logger");

function loadRoom() {
  delete require.cache[roomPath];
  const originalLoad = Module._load;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "uuid") {
      return { v4: () => "room-1" };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { info() {}, warn() {}, error() {} },
  };

  const Room = require("../../../src/rooms/Room");
  Module._load = originalLoad;
  return Room;
}

class FakeTransport extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.closed = false;
    this.iceParameters = { usernameFragment: `${id}-ufrag` };
    this.iceCandidates = [{ foundation: `${id}-foundation` }];
    this.dtlsParameters = { role: "auto" };
    this.sctpParameters = { port: 5000 };
  }

  async connect({ dtlsParameters }) {
    this.connectedWith = dtlsParameters;
  }

  async produce(params) {
    return new FakeProducer("producer-1", params.kind);
  }

  async consume({ producerId }) {
    return new FakeConsumer("consumer-1", producerId, "audio");
  }

  close() {
    this.closed = true;
  }
}

class FakeProducer extends EventEmitter {
  constructor(id, kind) {
    super();
    this.id = id;
    this.kind = kind;
    this.closed = false;
  }
}

class FakeConsumer extends EventEmitter {
  constructor(id, producerId, kind) {
    super();
    this.id = id;
    this.producerId = producerId;
    this.kind = kind;
    this.rtpParameters = { codecs: [] };
    this.appData = { source: "test" };
    this.closed = false;
    this.resumeCalls = 0;
  }

  async resume() {
    this.resumeCalls += 1;
  }

  close() {
    this.closed = true;
  }
}

function createRouter() {
  const transports = [];
  return {
    transports,
    rtpCapabilities: { codecs: [] },
    closed: false,
    canConsumeResult: true,
    async createWebRtcTransport(options) {
      this.lastTransportOptions = options;
      const transport = new FakeTransport(`transport-${transports.length + 1}`);
      transports.push(transport);
      return transport;
    },
    canConsume() {
      return this.canConsumeResult;
    },
    close() {
      this.closed = true;
    },
  };
}

test("Room creates transports, producers and consumers for the WebRTC happy path", async () => {
  const Room = loadRoom();
  const router = createRouter();
  const room = new Room({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    router,
  });

  const sendTransport = await room.createWebRtcTransport("artist-socket", "send");
  const producer = await room.createProducer("artist-socket", {
    kind: "audio",
    rtpParameters: { codecs: [] },
  });
  await room.createWebRtcTransport("listener-socket", "recv");
  room.addListener("listener-socket");
  const consumer = await room.createConsumer("listener-socket", producer.id, { codecs: [] });

  assert.equal(sendTransport.id, "transport-1");
  assert.equal(router.lastTransportOptions.listenInfos[0].protocol, "udp");
  assert.equal(producer.kind, "audio");
  assert.equal(room.status, "LIVE");
  assert.deepEqual(room.producerIds, ["producer-1"]);
  assert.equal(consumer.producerId, "producer-1");
  assert.equal(room.ownsConsumer("listener-socket", consumer.id), true);
  assert.equal(room.listenerCount, 1);
});

test("Room rejects producer and consumer creation when required resources are missing", async () => {
  const Room = loadRoom();
  const router = createRouter();
  const room = new Room({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    router,
  });

  await assert.rejects(
    () => room.createProducer("artist-socket", { kind: "audio", rtpParameters: {} }),
    /No send transport/
  );
  await assert.rejects(
    () => room.createConsumer("listener-socket", "missing-producer", { codecs: [] }),
    /Producer missing-producer not found/
  );
});

test("Room closes peer resources and removes consumer ownership indexes", async () => {
  const Room = loadRoom();
  const router = createRouter();
  const room = new Room({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    router,
  });

  await room.createWebRtcTransport("artist-socket", "send");
  const producer = await room.createProducer("artist-socket", {
    kind: "audio",
    rtpParameters: { codecs: [] },
  });
  await room.createWebRtcTransport("listener-socket", "recv");
  const consumer = await room.createConsumer("listener-socket", producer.id, { codecs: [] });

  room.closePeerResources("listener-socket", ["recv"]);

  assert.equal(consumer.closed, true);
  assert.equal(room.ownsConsumer("listener-socket", consumer.id), false);
  assert.equal(router.transports[1].closed, true);
});

test("Room close marks the concert as ended and closes router resources", async () => {
  const Room = loadRoom();
  const router = createRouter();
  const room = new Room({
    artistId: "artist-1",
    artistName: "Stage Name",
    title: "Friday Live",
    router,
  });

  await room.createWebRtcTransport("artist-socket", "send");
  await room.close();

  assert.equal(room.status, "ENDED");
  assert.equal(router.transports[0].closed, true);
  assert.equal(router.closed, true);
});

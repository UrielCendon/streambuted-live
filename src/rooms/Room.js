"use strict";

const { v4: uuidv4 } = require("uuid");
const logger          = require("../logger");

function getMediasoupListenInfo(protocol) {
  const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1";

  if (
    process.env.NODE_ENV === "production" &&
    /^(localhost|127\.|0\.0\.0\.0$)/i.test(announcedAddress)
  ) {
    throw new Error("MEDIASOUP_ANNOUNCED_IP must be the public Droplet IP in production.");
  }

  return {
    protocol,
    ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
    announcedAddress,
  };
}

class Room {

  constructor({ artistId, artistName, title, router }) {
    this.id          = uuidv4();
    this.artistId    = artistId;
    this.artistName  = artistName;
    this.title       = title;
    this.router      = router;
    this.createdAt   = new Date().toISOString();
    this.status      = "CREATED";

    this._transports = new Map();

    this._producers  = new Map();

    this._consumers  = new Map();
    this._consumerSocketIndex = new Map();

    this._listeners  = new Set();

    logger.info(`Room created  roomId=${this.id}  artist=${artistId}  title="${title}"`);
  }

  async createWebRtcTransport(socketId, direction) {
    const transport = await this.router.createWebRtcTransport({
      listenInfos: [
        getMediasoupListenInfo("udp"),
        getMediasoupListenInfo("tcp"),
      ],
      enableUdp    : true,
      enableTcp    : true,
      preferUdp    : true,

      initialAvailableOutgoingBitrate: 1_000_000,
    });

    transport.on("dtlsstatechange", (state) => {
      logger.info(`Transport DTLS state  transportId=${transport.id}  dir=${direction}  state=${state}`);
      if (state === "closed") {
        logger.info(`Transport closed  transportId=${transport.id}`);
        this._transports.delete(`${socketId}:${direction}`);
      }
    });

    transport.on("icestatechange", (state) => {
      logger.info(`Transport ICE state  transportId=${transport.id}  dir=${direction}  state=${state}`);
    });

    this._transports.set(`${socketId}:${direction}`, transport);
    logger.info(`Transport created  roomId=${this.id}  socketId=${socketId}  dir=${direction}`);
    return transport;
  }

  async createProducer(socketId, produceParams) {
    const transport = this._transports.get(`${socketId}:send`);
    if (!transport) throw new Error(`No send transport for socket ${socketId}`);

    const producer = await transport.produce(produceParams);
    this._producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      logger.info(`Producer transport closed  producerId=${producer.id}`);
      this._producers.delete(producer.id);
    });

    if (this.status === "CREATED") {
      this.status = "LIVE";
      logger.info(`Room is now LIVE  roomId=${this.id}`);
    }

    logger.info(`Producer created  roomId=${this.id}  kind=${producer.kind}  id=${producer.id}`);
    return producer;
  }

  async createConsumer(listenerSocketId, producerId, rtpCapabilities) {
    const producer = this._producers.get(producerId);
    if (!producer) throw new Error(`Producer ${producerId} not found`);

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Router cannot consume producer ${producerId} with given rtpCapabilities`);
    }

    const transport = this._transports.get(`${listenerSocketId}:recv`);
    if (!transport) throw new Error(`No recv transport for socket ${listenerSocketId}`);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    this._consumers.set(consumer.id, consumer);
    this._consumerSocketIndex.set(consumer.id, listenerSocketId);

    consumer.on("transportclose", () => {
      this._consumers.delete(consumer.id);
      this._consumerSocketIndex.delete(consumer.id);
    });
    consumer.on("producerclose", () => {
      this._consumers.delete(consumer.id);
      this._consumerSocketIndex.delete(consumer.id);
    });

    logger.info(`Consumer created  roomId=${this.id}  listener=${listenerSocketId}  kind=${consumer.kind}`);
    return consumer;
  }

  addListener(socketId)    { this._listeners.add(socketId); }
  removeListener(socketId) { this._listeners.delete(socketId); }
  hasListener(socketId)    { return this._listeners.has(socketId); }
  ownsConsumer(socketId, consumerId) {
    return this._consumerSocketIndex.get(consumerId) === socketId;
  }
  get listenerCount()      { return this._listeners.size; }
  get producerIds()        { return [...this._producers.keys()]; }

  closePeerResources(socketId, directions = ["send", "recv"]) {
    for (const [consumerId, ownerSocketId] of this._consumerSocketIndex.entries()) {
      if (ownerSocketId === socketId) {
        const consumer = this._consumers.get(consumerId);
        if (consumer && !consumer.closed) consumer.close();
        this._consumers.delete(consumerId);
        this._consumerSocketIndex.delete(consumerId);
      }
    }

    for (const direction of directions) {
      const key = `${socketId}:${direction}`;
      const transport = this._transports.get(key);
      if (transport && !transport.closed) transport.close();
      this._transports.delete(key);
    }
  }

  async close() {
    this.status = "ENDED";
    for (const transport of this._transports.values()) transport.close();
    this._consumerSocketIndex.clear();
    this.router.close();
    logger.info(`Room closed  roomId=${this.id}`);
  }

  toJSON() {
    return {
      id          : this.id,
      artistId    : this.artistId,
      artistName  : this.artistName,
      title       : this.title,
      status      : this.status,
      listeners   : this.listenerCount,
      createdAt   : this.createdAt,
    };
  }
}

module.exports = Room;

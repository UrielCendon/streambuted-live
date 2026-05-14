"use strict";

const Room         = require("./Room");
const { createRouter } = require("../sfu/workerPool");
const logger       = require("../logger");

class RoomManager {
  constructor() {

    this._rooms = new Map();

    this._artistRoomIndex = new Map();
  }

  getLiveRooms() {
    return [...this._rooms.values()].filter((r) => r.status === "LIVE");
  }

  getRoom(roomId) {
    return this._rooms.get(roomId);
  }

  getOrThrow(roomId) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    return room;
  }

  async createRoom({ artistId, artistName, title }) {

    const existingId = this._artistRoomIndex.get(artistId);
    if (existingId) {
      const existing = this._rooms.get(existingId);
      if (existing && existing.status !== "ENDED") {
        logger.warn(`Artist ${artistId} already has active room ${existingId}`);
        return existing;
      }
    }

    const router = await createRouter();
    const room   = new Room({ artistId, artistName, title, router });

    this._rooms.set(room.id, room);
    this._artistRoomIndex.set(artistId, room.id);

    logger.info(`Room registered  roomId=${room.id}  artist=${artistId}`);
    return room;
  }

  async closeRoom(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return;

    await room.close();
    this._rooms.delete(roomId);
    this._artistRoomIndex.delete(room.artistId);
    logger.info(`Room removed from registry  roomId=${roomId}`);
  }
}

module.exports = new RoomManager();

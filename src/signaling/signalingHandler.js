"use strict";

const logger = require("../logger");
const { getAuthenticatedUsername } = require("../auth/profileClient");
const {
  isObject,
  normalizeTitle,
  validateDirection,
  validateKind,
  validateRoomId,
} = require("../validation/liveValidator");

module.exports = function signalingHandler(io, socket, roomManager) {
  const { userId, role, name: userName } = socket.user;
  const isArtistRole = String(role || "").toUpperCase().replace(/^ROLE_/, "") === "ARTIST";

  const replyError = (event, message, err) => {
    logger.warn(`[${event}] error for user=${userId}: ${message}`, { err: err?.message });
    socket.emit(`${event}:error`, { error: "VALIDATION_OR_RUNTIME_ERROR", message });
  };

  socket.on("live:create", async ({ title } = {}) => {
    if (!isArtistRole) {
      return replyError("live:create", "Only artists can start a live concert");
    }

    const concertTitle = normalizeTitle(title);
    if (!concertTitle) {
      return replyError("live:create", "Concert title is required");
    }

    try {
      const artistName = await getAuthenticatedUsername(socket.data?.authToken);
      const room = await roomManager.createRoom({
        artistId  : userId,
        artistName: artistName || userName,
        title     : concertTitle,
      });

      socket.join(room.id);
      socket.data.roomId   = room.id;
      socket.data.isArtist = true;
      socket.emit("live:listenerCount", { roomId: room.id, count: room.listenerCount });

      socket.emit("live:created", {
        roomId                : room.id,
        routerRtpCapabilities : room.router.rtpCapabilities,
      });

      logger.info(`Artist ${userId} created room ${room.id}`);
    } catch (err) {
      replyError("live:create", err.message, err);
    }
  });

  socket.on("live:end", async ({ roomId } = {}) => {
    if (!isArtistRole) return;

    const targetRoomId = validateRoomId(roomId);
    if (!targetRoomId) {
      return replyError("live:end", "Room id is required");
    }

    try {
      const room = roomManager.getRoom(targetRoomId);
      if (!room || room.artistId !== userId) {
        return replyError("live:end", "Room not found or you are not the owner");
      }

      io.to(targetRoomId).emit("live:ended", { roomId: targetRoomId, reason: "ARTIST_ENDED" });

      await roomManager.closeRoom(targetRoomId);
      socket.leave(targetRoomId);
      socket.data.roomId   = null;
      socket.data.isArtist = false;

      logger.info(`Artist ${userId} ended room ${targetRoomId}`);
    } catch (err) {
      replyError("live:end", err.message, err);
    }
  });

  socket.on("live:join", async ({ roomId } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    if (!targetRoomId) {
      return replyError("live:join", "Room id is required");
    }

    try {
      const room = roomManager.getOrThrow(targetRoomId);
      if (room.status !== "LIVE" && room.status !== "CREATED") {
        return replyError("live:join", "Concert has ended");
      }

      if (socket.data?.roomId && socket.data.roomId !== targetRoomId) {
        const previousRoom = roomManager.getRoom(socket.data.roomId);
        if (previousRoom) {
          previousRoom.removeListener(socket.id);
          previousRoom.closePeerResources(socket.id, ["recv"]);
          io.to(socket.data.roomId).emit("live:listenerCount", {
            roomId: socket.data.roomId,
            count: previousRoom.listenerCount,
          });
        }
        socket.leave(socket.data.roomId);
      }

      room.closePeerResources(socket.id, ["recv"]);
      socket.join(targetRoomId);
      socket.data.roomId   = targetRoomId;
      socket.data.isArtist = false;
      room.addListener(socket.id);
      io.to(targetRoomId).emit("live:listenerCount", { roomId: targetRoomId, count: room.listenerCount });

      socket.emit("live:joined", {
        roomId               : room.id,
        routerRtpCapabilities: room.router.rtpCapabilities,
        producerIds          : room.producerIds,
      });

      logger.info(`Listener ${userId} joined room ${targetRoomId}`);
    } catch (err) {
      replyError("live:join", err.message, err);
    }
  });

  socket.on("live:createTransport", async ({ roomId, direction } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    const targetDirection = validateDirection(direction);

    if (!targetRoomId) {
      return replyError("live:createTransport", "Room id is required");
    }
    if (!targetDirection) {
      return replyError("live:createTransport", "Transport direction is invalid");
    }

    try {
      const room      = roomManager.getOrThrow(targetRoomId);
      const transport = await room.createWebRtcTransport(socket.id, targetDirection);

      socket.emit("live:transportCreated", {
        direction: targetDirection,
        id              : transport.id,
        iceParameters   : transport.iceParameters,
        iceCandidates   : transport.iceCandidates,
        dtlsParameters  : transport.dtlsParameters,
        sctpParameters  : transport.sctpParameters,
      });
    } catch (err) {
      replyError("live:createTransport", err.message, err);
    }
  });

  socket.on("live:connectTransport", async ({ roomId, transportId, dtlsParameters, direction } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    const targetDirection = validateDirection(direction);

    if (!targetRoomId) {
      return replyError("live:connectTransport", "Room id is required");
    }
    if (!targetDirection) {
      return replyError("live:connectTransport", "Transport direction is invalid");
    }
    if (!validateRoomId(transportId) || !isObject(dtlsParameters)) {
      return replyError("live:connectTransport", "Transport parameters are invalid");
    }

    try {
      const room      = roomManager.getOrThrow(targetRoomId);
      const transport = room._transports.get(`${socket.id}:${targetDirection}`);
      if (!transport || transport.id !== transportId) {
        return replyError("live:connectTransport", "Transport not found");
      }

      await transport.connect({ dtlsParameters });
      socket.emit("live:transportConnected", { transportId });
    } catch (err) {
      replyError("live:connectTransport", err.message, err);
    }
  });

  socket.on("live:produce", async ({ roomId, kind, rtpParameters, appData } = {}) => {
    if (!isArtistRole) {
      return replyError("live:produce", "Only artists can produce media");
    }

    const targetRoomId = validateRoomId(roomId);
    const targetKind = validateKind(kind);

    if (!targetRoomId) {
      return replyError("live:produce", "Room id is required");
    }
    if (!targetKind || !isObject(rtpParameters)) {
      return replyError("live:produce", "Producer parameters are invalid");
    }

    try {
      const room     = roomManager.getOrThrow(targetRoomId);
      const producer = await room.createProducer(socket.id, { kind: targetKind, rtpParameters, appData });

      socket.to(targetRoomId).emit("live:newProducer", {
        producerId: producer.id,
        kind      : producer.kind,
      });

      socket.emit("live:produced", { producerId: producer.id });
    } catch (err) {
      replyError("live:produce", err.message, err);
    }
  });

  socket.on("live:consume", async ({ roomId, producerId, rtpCapabilities } = {}) => {
    const targetRoomId = validateRoomId(roomId);

    if (!targetRoomId) {
      return replyError("live:consume", "Room id is required");
    }
    if (!validateRoomId(producerId) || !isObject(rtpCapabilities)) {
      return replyError("live:consume", "Consumer parameters are invalid");
    }

    try {
      const room     = roomManager.getOrThrow(targetRoomId);
      const consumer = await room.createConsumer(socket.id, producerId, rtpCapabilities);

      socket.emit("live:consumed", {
        consumerId    : consumer.id,
        producerId    : consumer.producerId,
        kind          : consumer.kind,
        rtpParameters : consumer.rtpParameters,
        appData       : consumer.appData,
      });
    } catch (err) {
      replyError("live:consume", err.message, err);
    }
  });

  socket.on("live:resumeConsumer", async ({ roomId, consumerId } = {}) => {
    const targetRoomId = validateRoomId(roomId);

    if (!targetRoomId) {
      return replyError("live:resumeConsumer", "Room id is required");
    }
    if (!validateRoomId(consumerId)) {
      return replyError("live:resumeConsumer", "Consumer id is required");
    }

    try {
      const room     = roomManager.getOrThrow(targetRoomId);
      const consumer = room._consumers.get(consumerId);
      if (!consumer) return replyError("live:resumeConsumer", "Consumer not found");

      await consumer.resume();
      logger.info(`Consumer resumed  consumerId=${consumerId}`);
    } catch (err) {
      replyError("live:resumeConsumer", err.message, err);
    }
  });

  socket.on("live:leave", async ({ roomId } = {}) => {
    try {
      const targetRoomId = validateRoomId(roomId) || socket.data?.roomId;
      if (!targetRoomId) return;
      const room = roomManager.getRoom(targetRoomId);
      if (!room) return;

      room.removeListener(socket.id);
      room.closePeerResources(socket.id, ["recv"]);

      socket.leave(targetRoomId);
      socket.data.roomId = null;
      socket.data.isArtist = false;
      io.to(targetRoomId).emit("live:listenerCount", { roomId: targetRoomId, count: room.listenerCount });
    } catch (err) {
      replyError("live:leave", err.message, err);
    }
  });

  socket.on("disconnect", async (reason) => {
    logger.info(`Socket disconnected  userId=${userId}  reason=${reason}`);

    const roomId = socket.data?.roomId;
    if (!roomId) return;

    const room = roomManager.getRoom(roomId);
    if (!room) return;

    if (socket.data.isArtist) {
      io.to(roomId).emit("live:ended", { roomId, reason: "ARTIST_DISCONNECTED" });
      await roomManager.closeRoom(roomId);
    } else {
      room.removeListener(socket.id);
      io.to(roomId).emit("live:listenerCount", { roomId, count: room.listenerCount });
      room.closePeerResources(socket.id, ["recv"]);
    }
  });
};

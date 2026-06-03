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
  const publicErrorMessages = {
    conflict_or_state_changed: "El contenido cambio y no se pudo completar la accion. Intenta nuevamente.",
    dependency_validation_failed: "No se pudo validar la informacion relacionada con esta accion. Intenta nuevamente.",
    invalid_input: "La solicitud no cumple con el formato esperado.",
    request_timeout: "La solicitud tardo demasiado y no se pudo completar. Intenta nuevamente.",
    resource_not_found: "El contenido solicitado ya no esta disponible.",
    service_temporarily_unavailable: "Esta funcion no esta disponible en este momento. Intenta de nuevo mas tarde.",
    unauthorized: "Tu sesion expiro. Inicia sesion nuevamente.",
    unexpected_operation_failure: "No se pudo completar la accion en este momento. Intenta de nuevo mas tarde.",
    forbidden: "No tienes permisos para esta accion.",
  };

  const inferPublicCode = (code, message) => {
    const normalized = `${String(code || "").toLowerCase()} ${String(message || "").toLowerCase()}`;
    if (normalized.includes("timeout") || normalized.includes("tardo demasiado")) {
      return "request_timeout";
    }
    if (
      normalized.includes("required")
        || normalized.includes("invalid")
        || normalized.includes("obligatorio")
        || normalized.includes("no son validos")
        || normalized.includes("no es valida")
    ) {
      return "invalid_input";
    }
    if (
      normalized.includes("not_found")
        || normalized.includes("no existe")
        || normalized.includes("no esta disponible")
        || normalized.includes("finalizo")
    ) {
      return "resource_not_found";
    }
    if (
      normalized.includes("forbidden")
        || normalized.includes("artist_role_required")
        || normalized.includes("join_required")
        || normalized.includes("no te pertenece")
    ) {
      return "forbidden";
    }
    if (
      normalized.includes("failed")
        || normalized.includes("create_failed")
        || normalized.includes("connect_failed")
        || normalized.includes("consume_failed")
    ) {
      return "service_temporarily_unavailable";
    }
    return "unexpected_operation_failure";
  };

  const replyError = (event, code, message, err) => {
    logger.warn(`[${event}] error for user=${userId}: ${message}`, { err: err?.message });
    const publicCode = inferPublicCode(code, message);
    const publicMessage = publicErrorMessages[publicCode] ?? publicErrorMessages.unexpected_operation_failure;
    socket.emit(`${event}:error`, { error: code, code: publicCode, message: publicMessage });
  };

  const getAuthorizedRoom = (event, roomId, direction = null) => {
    const room = roomManager.getRoom(roomId);
    if (!room) {
      replyError(event, "ROOM_NOT_FOUND_OR_FORBIDDEN", "La sala no existe o no esta disponible.");
      return null;
    }

    if (direction === "send" || event === "live:produce") {
      if (!isArtistRole || room.artistId !== userId) {
        replyError(event, "ROOM_NOT_FOUND_OR_FORBIDDEN", "La sala no existe o no te pertenece.");
        return null;
      }
    }

    if (direction === "recv" || event === "live:consume" || event === "live:resumeConsumer") {
      if (!socket.rooms.has(roomId) || !room.hasListener(socket.id)) {
        replyError(event, "ROOM_JOIN_REQUIRED", "Debes entrar a la sala antes de consumir media.");
        return null;
      }
    }

    return room;
  };

  socket.on("live:create", async ({ title } = {}) => {
    if (!isArtistRole) {
      return replyError("live:create", "ARTIST_ROLE_REQUIRED", "Solo los artistas pueden iniciar un concierto en vivo.");
    }

    const concertTitle = normalizeTitle(title);
    if (!concertTitle) {
      return replyError("live:create", "TITLE_REQUIRED", "El titulo del concierto es obligatorio.");
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
      replyError("live:create", "LIVE_CREATE_FAILED", "No se pudo crear la sala de live.", err);
    }
  });

  socket.on("live:end", async ({ roomId } = {}) => {
    if (!isArtistRole) return;

    const targetRoomId = validateRoomId(roomId);
    if (!targetRoomId) {
      return replyError("live:end", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }

    try {
      const room = roomManager.getRoom(targetRoomId);
      if (!room || room.artistId !== userId) {
        return replyError("live:end", "ROOM_NOT_FOUND_OR_FORBIDDEN", "La sala no existe o no te pertenece.");
      }

      io.to(targetRoomId).emit("live:ended", { roomId: targetRoomId, reason: "ARTIST_ENDED" });

      await roomManager.closeRoom(targetRoomId);
      socket.leave(targetRoomId);
      socket.data.roomId   = null;
      socket.data.isArtist = false;

      logger.info(`Artist ${userId} ended room ${targetRoomId}`);
    } catch (err) {
      replyError("live:end", "LIVE_END_FAILED", "No se pudo finalizar la sala de live.", err);
    }
  });

  socket.on("live:join", async ({ roomId } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    if (!targetRoomId) {
      return replyError("live:join", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }

    try {
      const room = roomManager.getRoom(targetRoomId);
      if (!room) {
        return replyError("live:join", "ROOM_NOT_FOUND", "La sala no existe o no esta disponible.");
      }
      if (room.status !== "LIVE" && room.status !== "CREATED") {
        return replyError("live:join", "CONCERT_ENDED", "El concierto ya finalizo.");
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
      replyError("live:join", "LIVE_JOIN_FAILED", "No se pudo entrar a la sala de live.", err);
    }
  });

  socket.on("live:createTransport", async ({ roomId, direction } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    const targetDirection = validateDirection(direction);

    if (!targetRoomId) {
      return replyError("live:createTransport", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }
    if (!targetDirection) {
      return replyError("live:createTransport", "TRANSPORT_DIRECTION_INVALID", "La direccion del transporte no es valida.");
    }

    try {
      const room      = getAuthorizedRoom("live:createTransport", targetRoomId, targetDirection);
      if (!room) return;
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
      replyError("live:createTransport", "TRANSPORT_CREATE_FAILED", "No se pudo crear el transporte.", err);
    }
  });

  socket.on("live:connectTransport", async ({ roomId, transportId, dtlsParameters, direction } = {}) => {
    const targetRoomId = validateRoomId(roomId);
    const targetDirection = validateDirection(direction);

    if (!targetRoomId) {
      return replyError("live:connectTransport", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }
    if (!targetDirection) {
      return replyError("live:connectTransport", "TRANSPORT_DIRECTION_INVALID", "La direccion del transporte no es valida.");
    }
    if (!validateRoomId(transportId) || !isObject(dtlsParameters)) {
      return replyError("live:connectTransport", "TRANSPORT_PARAMS_INVALID", "Los parametros del transporte no son validos.");
    }

    try {
      const room      = getAuthorizedRoom("live:connectTransport", targetRoomId, targetDirection);
      if (!room) return;
      const transport = room._transports.get(`${socket.id}:${targetDirection}`);
      if (!transport || transport.id !== transportId) {
        return replyError("live:connectTransport", "TRANSPORT_NOT_FOUND", "El transporte no existe o ya no esta disponible.");
      }

      await transport.connect({ dtlsParameters });
      socket.emit("live:transportConnected", { transportId });
    } catch (err) {
      replyError("live:connectTransport", "TRANSPORT_CONNECT_FAILED", "No se pudo conectar el transporte.", err);
    }
  });

  socket.on("live:produce", async ({ roomId, kind, rtpParameters, appData } = {}) => {
    if (!isArtistRole) {
      return replyError("live:produce", "ARTIST_ROLE_REQUIRED", "Solo los artistas pueden producir media.");
    }

    const targetRoomId = validateRoomId(roomId);
    const targetKind = validateKind(kind);

    if (!targetRoomId) {
      return replyError("live:produce", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }
    if (!targetKind || !isObject(rtpParameters)) {
      return replyError("live:produce", "PRODUCER_PARAMS_INVALID", "Los parametros del productor no son validos.");
    }

    try {
      const room     = getAuthorizedRoom("live:produce", targetRoomId);
      if (!room) return;
      const producer = await room.createProducer(socket.id, { kind: targetKind, rtpParameters, appData });

      socket.to(targetRoomId).emit("live:newProducer", {
        producerId: producer.id,
        kind      : producer.kind,
      });

      socket.emit("live:produced", { producerId: producer.id });
    } catch (err) {
      replyError("live:produce", "PRODUCE_FAILED", "No se pudo publicar la media.", err);
    }
  });

  socket.on("live:consume", async ({ roomId, producerId, rtpCapabilities } = {}) => {
    const targetRoomId = validateRoomId(roomId);

    if (!targetRoomId) {
      return replyError("live:consume", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }
    if (!validateRoomId(producerId) || !isObject(rtpCapabilities)) {
      return replyError("live:consume", "CONSUMER_PARAMS_INVALID", "Los parametros del consumidor no son validos.");
    }

    try {
      const room     = getAuthorizedRoom("live:consume", targetRoomId);
      if (!room) return;
      const consumer = await room.createConsumer(socket.id, producerId, rtpCapabilities);

      socket.emit("live:consumed", {
        consumerId    : consumer.id,
        producerId    : consumer.producerId,
        kind          : consumer.kind,
        rtpParameters : consumer.rtpParameters,
        appData       : consumer.appData,
      });
    } catch (err) {
      replyError("live:consume", "CONSUME_FAILED", "No se pudo consumir la media.", err);
    }
  });

  socket.on("live:resumeConsumer", async ({ roomId, consumerId } = {}) => {
    const targetRoomId = validateRoomId(roomId);

    if (!targetRoomId) {
      return replyError("live:resumeConsumer", "ROOM_ID_REQUIRED", "roomId es obligatorio.");
    }
    if (!validateRoomId(consumerId)) {
      return replyError("live:resumeConsumer", "CONSUMER_ID_REQUIRED", "consumerId es obligatorio.");
    }

    try {
      const room     = getAuthorizedRoom("live:resumeConsumer", targetRoomId);
      if (!room) return;
      const consumer = room._consumers.get(consumerId);
      if (!consumer) return replyError("live:resumeConsumer", "CONSUMER_NOT_FOUND", "El consumidor no existe o ya no esta disponible.");
      if (!room.ownsConsumer(socket.id, consumerId)) {
        return replyError("live:resumeConsumer", "CONSUMER_NOT_FOUND", "El consumidor no existe o ya no esta disponible.");
      }

      await consumer.resume();
      logger.info(`Consumer resumed  consumerId=${consumerId}`);
    } catch (err) {
      replyError("live:resumeConsumer", "CONSUMER_RESUME_FAILED", "No se pudo reanudar el consumidor.", err);
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
      replyError("live:leave", "LIVE_LEAVE_FAILED", "No se pudo salir de la sala de live.", err);
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

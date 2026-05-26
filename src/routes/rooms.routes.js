"use strict";

const { Router } = require("express");
const roomManager = require("../rooms/roomManager");
const logger = require("../logger");
const { getAuthenticatedUsername } = require("../auth/profileClient");
const { sendError } = require("../http/errorResponse");
const { normalizeTitle, validateRoomId } = require("../validation/liveValidator");

const router = Router();

router.get("/rooms", (_req, res) => {
  const rooms = roomManager.getLiveRooms().map((room) => room.toJSON());
  res.json({ data: rooms, total: rooms.length });
});

router.get("/rooms/:roomId", (req, res) => {
  const roomId = validateRoomId(req.params.roomId);

  if (!roomId) {
    return sendError(res, 400, "VALIDATION_ERROR", "roomId es obligatorio.");
  }

  const room = roomManager.getRoom(roomId);

  if (!room) {
    return sendError(res, 404, "ROOM_NOT_FOUND", "La sala no existe o ya no esta disponible.");
  }

  res.json(room.toJSON());
});

router.post("/rooms", async (req, res) => {
  const { userId, role, name: artistName } = req.user;

  if (String(role || "").toUpperCase().replace(/^ROLE_/, "") !== "ARTIST") {
    return sendError(res, 403, "FORBIDDEN", "Solo los artistas pueden crear salas.");
  }

  const title = normalizeTitle(req.body?.title);
  if (!title) {
    return sendError(res, 400, "VALIDATION_ERROR", "El titulo es obligatorio.");
  }

  try {
    const username = await getAuthenticatedUsername(req.authToken);
    const room = await roomManager.createRoom({
      artistId: userId,
      artistName: username || artistName,
      title,
    });

    res.status(201).json(room.toJSON());
  } catch (err) {
    logger.error(`POST /rooms failed: ${err.message}`);
    sendError(res, 500, "INTERNAL_ERROR", "Ocurrio un error interno. Intenta de nuevo mas tarde.");
  }
});

module.exports = router;

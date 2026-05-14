"use strict";

const mediasoup = require("mediasoup");
const os        = require("os");
const logger    = require("../logger");

const MEDIA_CODECS = [
  {
    kind      : "audio",
    mimeType  : "audio/opus",
    clockRate : 48000,
    channels  : 2,
  },
  {
    kind       : "video",
    mimeType   : "video/VP8",
    clockRate  : 90000,
    parameters : {
      "x-google-start-bitrate": 1000,
    },
  },
];

const WORKER_SETTINGS = {
  logLevel : "warn",
  logTags  : ["rtp", "ice", "dtls"],

  rtcMinPort: parseInt(process.env.RTC_MIN_PORT || "10000"),
  rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || "10100"),
};

let workers    = [];
let workerIdx  = 0;

async function createWorkers() {
  const numWorkers = Math.min(os.cpus().length, 4);
  logger.info(`Creating ${numWorkers} mediasoup worker(s)`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker(WORKER_SETTINGS);

    worker.on("died", (err) => {
      logger.error(`mediasoup worker[${i}] died – process will exit`, { err: err?.message });
      process.exit(1);
    });

    workers.push(worker);
    logger.info(`Worker[${i}] created  pid=${worker.pid}`);
  }
}

function getNextWorker() {
  const worker = workers[workerIdx];
  workerIdx    = (workerIdx + 1) % workers.length;
  return worker;
}

async function createRouter() {
  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  logger.info(`Router created  routerId=${router.id}  workerId=${worker.pid}`);
  return router;
}

module.exports = { createWorkers, createRouter, MEDIA_CODECS };

'use strict';

const crypto = require('crypto');
const { PIPELINE_VERSION } = require('./constants');
const { normalizeImgid, rotationAngle } = require('./select');

function canonicalGeneration(generation) {
  const g = generation || {};
  return {
    x1: g.x1 == null ? null : g.x1,
    y1: g.y1 == null ? null : g.y1,
    x2: g.x2 == null ? null : g.x2,
    y2: g.y2 == null ? null : g.y2,
    angle: rotationAngle(g),
    coordinates_image_size: g.coordinates_image_size == null ? null : String(g.coordinates_image_size),
    normalize: g.normalize == null ? null : g.normalize,
    white_magic: g.white_magic == null ? null : g.white_magic,
  };
}

function sourceFingerprint({ imgid, generation, sourceKind, pipelineVersion = PIPELINE_VERSION }) {
  const payload = JSON.stringify({
    pipelineVersion,
    imgid: normalizeImgid(imgid),
    sourceKind: sourceKind || null,
    generation: canonicalGeneration(generation),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function shortFingerprint(hex) {
  return String(hex || '').slice(0, 10);
}

module.exports = { sourceFingerprint, shortFingerprint, canonicalGeneration };

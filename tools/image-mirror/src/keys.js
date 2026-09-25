'use strict';

const { PIPELINE_VERSION } = require('./constants');
const { shortFingerprint } = require('./fingerprint');

function objectKey({ barcode, lc, rev, fingerprint, pipelineVersion = PIPELINE_VERSION }) {
  const short = shortFingerprint(fingerprint);
  return `front/${barcode}/${lc}.${rev}.${short}.${pipelineVersion}.jpg`;
}

module.exports = { objectKey };

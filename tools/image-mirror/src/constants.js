'use strict';

const PIPELINE_VERSION = 'p2';
const SCOPE_SEARCH = 'search';
const SCOPE_ALL_US_FRONT = 'all_us_front';
const OUTPUT_SIZE = 200;
const JPEG_QUALITY = 82;
const MANIFEST_KEY = 'manifest/v1.json.gz';
const DEFAULT_WRITE_CAP = 20000;
const DEFAULT_CONCURRENCY = 8;
const MANIFEST_CHECKPOINT_EVERY = 25;
const OFF_DUMP_URL = 'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const OFF_IMAGE_BUCKET = 'https://openfoodfacts-images.s3.eu-west-3.amazonaws.com/data';
const USER_AGENT = 'PurlaImageMirror/1.0 (https://purla.io; image-mirror job; not the live API)';
const R2_BUCKET = 'purla-images';
const CONTACT_SHEET_RANDOM = 24;
const CONTACT_SHEET_TRANSFORM_CAP = 40;

module.exports = {
  PIPELINE_VERSION,
  SCOPE_SEARCH,
  SCOPE_ALL_US_FRONT,
  OUTPUT_SIZE,
  JPEG_QUALITY,
  MANIFEST_KEY,
  DEFAULT_WRITE_CAP,
  DEFAULT_CONCURRENCY,
  MANIFEST_CHECKPOINT_EVERY,
  OFF_DUMP_URL,
  OFF_IMAGE_BUCKET,
  USER_AGENT,
  R2_BUCKET,
  CONTACT_SHEET_RANDOM,
  CONTACT_SHEET_TRANSFORM_CAP,
};

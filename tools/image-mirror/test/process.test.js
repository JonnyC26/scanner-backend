'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { processToSquare, centerSquare, cropRect } = require('../src/process');
const { solidJpeg, gradientJpeg, quadrantJpeg, jpegWithOrientation, cornerMeans } = require('./helpers');

function isRed(c) { return c.r > 140 && c.r > c.g + 40 && c.r > c.b + 40; }
function isGreen(c) { return c.g > 140 && c.g > c.r + 40 && c.g > c.b + 40; }
function isBlue(c) { return c.b > 140 && c.b > c.r + 40 && c.b > c.g + 40; }
function isYellow(c) { return c.r > 140 && c.g > 140 && c.b < 90; }

describe('processToSquare', () => {
  it('emits a 200×200 JPEG from an uncropped source', async () => {
    const src = await solidJpeg(400, 300);
    const out = await processToSquare({
      sourceBuffer: src,
      generation: {},
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 200);
    assert.equal(meta.format, 'jpeg');
  });

  it('skips when the processed shorter side is under 200px before resize', async () => {
    const src = await solidJpeg(180, 180);
    const out = await processToSquare({
      sourceBuffer: src,
      generation: {},
      sourceKind: '400',
    });
    assert.equal(out.skip, 'too_small');
  });

  it('applies a 400-space crop in that pixel space', async () => {
    const src = await gradientJpeg(400, 400, {
      leftRgb: [220, 20, 20],
      rightRgb: [20, 40, 220],
    });
    const out = await processToSquare({
      sourceBuffer: src,
      generation: { x1: 200, y1: 0, x2: 400, y2: 400, coordinates_image_size: '400' },
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 200);
    assert.equal(info.height, 200);
    const i = (20 * 200 + 20) * info.channels;
    assert.ok(data[i + 2] > data[i], 'expected blue channel to dominate');
  });

  it('applies a full-space crop in that pixel space', async () => {
    const src = await gradientJpeg(800, 400, {
      leftRgb: [220, 20, 20],
      rightRgb: [20, 40, 220],
    });
    const out = await processToSquare({
      sourceBuffer: src,
      generation: { x1: 400, y1: 0, x2: 800, y2: 400, coordinates_image_size: 'full' },
      sourceKind: 'full',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 200);
  });

  it('skips when crop coords do not fit the source and dump sizes are absent', async () => {
    const src = await solidJpeg(400, 400);
    const out = await processToSquare({
      sourceBuffer: src,
      generation: { x1: 0, y1: 0, x2: 900, y2: 900, coordinates_image_size: 'full' },
      sourceKind: 'full',
    });
    assert.equal(out.skip, 'unmapped_coordinate_space');
  });

  it('rotates 90° clockwise (ImageMagick / Product Opener) before cropping', async () => {
    const src = await quadrantJpeg(400, 400);
    const out = await processToSquare({
      sourceBuffer: src,
      generation: {
        x1: 200,
        y1: 0,
        x2: 400,
        y2: 200,
        angle: 90,
        coordinates_image_size: '400',
      },
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const means = cornerMeans(data, info.width, info.height, info.channels);
    // 90° CW moves red TL → TR; the TR crop is that red block.
    assert.ok(isRed(means.tl) || isRed(means.tr) || isRed(means.bl) || isRed(means.br), JSON.stringify(means));
    assert.ok(isRed(means.tl) && isRed(means.tr) && isRed(means.bl) && isRed(means.br),
      `crop after 90° CW should be the red quadrant, got ${JSON.stringify(means)}`);
  });
});

describe('OFF rotation direction', () => {
  async function meansAfter(angle) {
    const src = await quadrantJpeg(400, 400);
    const out = await processToSquare({
      sourceBuffer: src,
      generation: { angle },
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    return cornerMeans(data, info.width, info.height, info.channels);
  }

  it('rotates 90° clockwise — red TL moves to TR', async () => {
    const m = await meansAfter(90);
    assert.ok(isRed(m.tr), `TR should be red after 90° CW: ${JSON.stringify(m)}`);
    assert.ok(isBlue(m.tl), `TL should be blue after 90° CW: ${JSON.stringify(m)}`);
  });
  it('rotates 180° — red TL moves to BR', async () => {
    const m = await meansAfter(180);
    assert.ok(isRed(m.br), `BR should be red after 180°: ${JSON.stringify(m)}`);
    assert.ok(isYellow(m.tl) || isGreen(m.tl) === false, JSON.stringify(m));
    assert.ok(isYellow(m.tl), `TL should be yellow after 180°: ${JSON.stringify(m)}`);
  });
  it('rotates 270° clockwise — red TL moves to BL', async () => {
    const m = await meansAfter(270);
    assert.ok(isRed(m.bl), `BL should be red after 270° CW: ${JSON.stringify(m)}`);
    assert.ok(isGreen(m.tl), `TL should be green after 270° CW: ${JSON.stringify(m)}`);
  });
});

describe('EXIF orientation', () => {
  it('ignores EXIF Orientation so there is no double rotation with generation.angle', async () => {
    const raw = await quadrantJpeg(400, 400);
    // Orientation 3 = 180°. Combined with generation 90 that would be 270 if applied.
    const tagged = await jpegWithOrientation(raw, 3);
    const taggedMeta = await sharp(tagged, { failOn: 'none' }).metadata();
    assert.equal(taggedMeta.orientation, 3);

    const out = await processToSquare({
      sourceBuffer: tagged,
      generation: { angle: 90 },
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const m = cornerMeans(data, info.width, info.height, info.channels);
    // Product Opener crop path: Rotate(generation) only. 90° CW → red at TR.
    // Double rotation (EXIF 180 + 90) would put red at BL.
    assert.ok(isRed(m.tr), `expected generation-only 90° CW (red at TR), got ${JSON.stringify(m)}`);
    assert.ok(!isRed(m.bl), `double rotation would put red at BL: ${JSON.stringify(m)}`);
  });
});

describe('geometry helpers', () => {
  it('builds a crop rect from unordered corners', () => {
    assert.deepEqual(cropRect({ x1: 80, y1: 20, x2: 10, y2: 60 }), {
      left: 10,
      top: 20,
      width: 70,
      height: 40,
    });
  });
  it('centre-crops to a square', () => {
    assert.deepEqual(centerSquare(400, 200), { left: 100, top: 0, width: 200, height: 200 });
  });
});

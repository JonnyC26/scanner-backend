'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { processToSquare, centerSquare, cropRect } = require('../src/process');
const { solidJpeg, gradientJpeg } = require('./helpers');

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

  it('rotates 90° before cropping so coords stay in the defined space', async () => {
    const src = await gradientJpeg(400, 200, {
      leftRgb: [220, 20, 20],
      rightRgb: [20, 40, 220],
    });
    const out = await processToSquare({
      sourceBuffer: src,
      generation: {
        x1: 0,
        y1: 0,
        x2: 200,
        y2: 200,
        angle: 90,
        coordinates_image_size: '400',
      },
      sourceKind: '400',
    });
    assert.ok(!out.skip, JSON.stringify(out));
    const meta = await sharp(out.buffer).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 200);
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

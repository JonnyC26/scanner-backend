'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { objectKey } = require('../src/keys');
const { sourceFingerprint, shortFingerprint } = require('../src/fingerprint');

const base = {
  imgid: '4',
  sourceKind: '400',
  generation: {
    x1: 10,
    y1: 20,
    x2: 200,
    y2: 220,
    angle: 0,
    coordinates_image_size: '400',
  },
};

describe('object key format', () => {
  it('is front/{barcode}/{lc}.{rev}.{shortFingerprint}.p2.jpg', () => {
    const fp = sourceFingerprint(base);
    const key = objectKey({
      barcode: '0012345678905',
      lc: 'en',
      rev: '12',
      fingerprint: fp,
    });
    const short = shortFingerprint(fp);
    assert.equal(short.length, 10);
    assert.equal(key, `front/0012345678905/en.12.${short}.p2.jpg`);
    assert.match(key, /^front\/0012345678905\/en\.12\.[0-9a-f]{10}\.p2\.jpg$/);
  });
  it('uses the same PIPELINE_VERSION constant as the fingerprint', () => {
    const { PIPELINE_VERSION } = require('../src/constants');
    assert.equal(PIPELINE_VERSION, 'p2');
    const fp = sourceFingerprint(base);
    assert.ok(objectKey({
      barcode: '0012345678905',
      lc: 'en',
      rev: '12',
      fingerprint: fp,
    }).includes(`.${PIPELINE_VERSION}.jpg`));
  });
});

describe('sourceFingerprint', () => {
  it('is stable when crop inputs are unchanged', () => {
    assert.equal(sourceFingerprint(base), sourceFingerprint({ ...base, generation: { ...base.generation } }));
  });
  it('changes when crop coordinates change', () => {
    const shifted = sourceFingerprint({
      ...base,
      generation: { ...base.generation, x1: 11 },
    });
    assert.notEqual(shifted, sourceFingerprint(base));
  });
  it('changes when imgid changes', () => {
    assert.notEqual(sourceFingerprint({ ...base, imgid: '5' }), sourceFingerprint(base));
  });
  it('changes when source kind changes', () => {
    assert.notEqual(sourceFingerprint({ ...base, sourceKind: 'full' }), sourceFingerprint(base));
  });
  it('changes when angle changes', () => {
    assert.notEqual(
      sourceFingerprint({ ...base, generation: { ...base.generation, angle: 90 } }),
      sourceFingerprint(base),
    );
  });
  it('is unchanged by unrelated product fields', () => {
    const a = sourceFingerprint(base);
    const b = sourceFingerprint({ ...base, productName: 'other', code: '999' });
    assert.equal(a, b);
  });
  it('changes when the pipeline version changes', () => {
    assert.notEqual(
      sourceFingerprint({ ...base, pipelineVersion: 'p1' }),
      sourceFingerprint({ ...base, pipelineVersion: 'p2' }),
    );
  });
});

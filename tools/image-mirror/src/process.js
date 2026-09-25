'use strict';

const sharp = require('sharp');
const { OUTPUT_SIZE, JPEG_QUALITY } = require('./constants');
const { rotationAngle, hasUsableCrop } = require('./select');

const TRIM_TOLERANCE = 8;

function cropRect(generation) {
  const x1 = generation.x1;
  const y1 = generation.y1;
  const x2 = generation.x2;
  const y2 = generation.y2;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function scaleCropIfNeeded(rect, actualW, actualH, refW, refH) {
  if (!refW || !refH) return { rect, mapped: actualW >= rect.left + rect.width && actualH >= rect.top + rect.height };
  if (refW === actualW && refH === actualH) {
    return { rect, mapped: actualW >= rect.left + rect.width && actualH >= rect.top + rect.height };
  }
  const scaled = {
    left: Math.round(rect.left * actualW / refW),
    top: Math.round(rect.top * actualH / refH),
    width: Math.round(rect.width * actualW / refW),
    height: Math.round(rect.height * actualH / refH),
  };
  return {
    rect: scaled,
    mapped: scaled.width > 0 && scaled.height > 0
      && scaled.left >= 0 && scaled.top >= 0
      && scaled.left + scaled.width <= actualW
      && scaled.top + scaled.height <= actualH,
  };
}

function referenceSize(uploadedSizes, space, angle) {
  if (!uploadedSizes || !space) return null;
  const ref = uploadedSizes[space];
  if (!ref || !ref.w || !ref.h) return null;
  let w = Number(ref.w);
  let h = Number(ref.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if ((angle % 180) === 90) {
    const z = w;
    w = h;
    h = z;
  }
  return { w, h };
}

function trimUniformBorders(data, width, height, channels, tolerance = TRIM_TOLERANCE) {
  const ref = [];
  for (let c = 0; c < Math.min(3, channels); c++) ref[c] = data[c];

  const isBorderPx = (x, y) => {
    const i = (y * width + x) * channels;
    for (let c = 0; c < Math.min(3, channels); c++) {
      if (Math.abs(data[i + c] - ref[c]) > tolerance) return false;
    }
    return true;
  };
  const rowIsBorder = (y) => {
    for (let x = 0; x < width; x++) if (!isBorderPx(x, y)) return false;
    return true;
  };
  const colIsBorder = (x) => {
    for (let y = 0; y < height; y++) if (!isBorderPx(x, y)) return false;
    return true;
  };

  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;
  while (top < bottom && rowIsBorder(top)) top++;
  while (bottom > top && rowIsBorder(bottom)) bottom--;
  while (left < right && colIsBorder(left)) left++;
  while (right > left && colIsBorder(right)) right--;

  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    const src = ((top + y) * width + left) * channels;
    data.copy(out, y * w * channels, src, src + w * channels);
  }
  return { data: out, width: w, height: h, channels };
}

function centerSquare(width, height) {
  const side = Math.min(width, height);
  return {
    left: Math.floor((width - side) / 2),
    top: Math.floor((height - side) / 2),
    width: side,
    height: side,
  };
}

async function processToSquare({ sourceBuffer, generation, uploadedSizes, sourceKind }) {
  const gen = generation || {};
  const angle = rotationAngle(gen);
  // Product Opener process_image_crop: $source->Rotate($angle) then Crop then Trim.
  // ImageMagick Rotate is clockwise; sharp.rotate(degrees) is also clockwise.
  // Always pass an explicit angle (including 0) so sharp does not apply EXIF
  // Orientation. Stored {imgid}.jpg files were already AutoOrient()+Strip() on
  // upload; the crop path never auto-orients again.
  const working = await sharp(sourceBuffer, { failOn: 'none' }).rotate(angle).toBuffer();

  let pipeline = sharp(working, { failOn: 'none' });
  const meta = await pipeline.metadata();
  const actualW = meta.width;
  const actualH = meta.height;
  if (!actualW || !actualH) {
    return { skip: 'unmapped_coordinate_space' };
  }

  if (hasUsableCrop(gen)) {
    const space = sourceKind === '400' ? '400' : 'full';
    const rect = cropRect(gen);
    const fits = rect.left >= 0 && rect.top >= 0
      && rect.width > 0 && rect.height > 0
      && rect.left + rect.width <= actualW
      && rect.top + rect.height <= actualH;
    if (fits) {
      pipeline = pipeline.extract(rect);
    } else {
      const ref = referenceSize(uploadedSizes, space, angle);
      if (!ref) return { skip: 'unmapped_coordinate_space' };
      const mapped = scaleCropIfNeeded(rect, actualW, actualH, ref.w, ref.h);
      if (!mapped.mapped) return { skip: 'unmapped_coordinate_space' };
      pipeline = pipeline.extract(mapped.rect);
    }
  }

  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const trimmed = trimUniformBorders(data, info.width, info.height, info.channels);
  if (trimmed.width < OUTPUT_SIZE || trimmed.height < OUTPUT_SIZE) {
    return { skip: 'too_small', width: trimmed.width, height: trimmed.height };
  }

  const sq = centerSquare(trimmed.width, trimmed.height);
  const jpeg = await sharp(trimmed.data, {
    raw: { width: trimmed.width, height: trimmed.height, channels: trimmed.channels },
  })
    .extract(sq)
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const outMeta = await sharp(jpeg).metadata();
  if (outMeta.width !== OUTPUT_SIZE || outMeta.height !== OUTPUT_SIZE) {
    return { skip: 'too_small' };
  }
  return { buffer: jpeg, width: OUTPUT_SIZE, height: OUTPUT_SIZE };
}

async function sourceShorterSide(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) return 0;
  return Math.min(meta.width, meta.height);
}

module.exports = {
  processToSquare,
  sourceShorterSide,
  trimUniformBorders,
  cropRect,
  scaleCropIfNeeded,
  centerSquare,
  OUTPUT_SIZE,
};

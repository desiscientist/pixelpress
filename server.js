const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createReference } = require('./lib/similarity');

const env = (name, fallback) => Number(process.env[name]) || fallback;

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per image
// Largest image we will decode, in pixels. Guards against "decompression bombs": small
// files that expand to gigabytes in memory. 50 MP covers 48 MP phone cameras.
const MAX_PIXELS = env('MAX_PIXELS', 50_000_000);
// Images processed at the same time. Each one can need a few hundred MB, so keep this
// low on small servers. Further requests wait in a queue, up to MAX_QUEUED_JOBS.
const MAX_CONCURRENT_JOBS = env('MAX_CONCURRENT_JOBS', 2);
const MAX_QUEUED_JOBS = env('MAX_QUEUED_JOBS', 30);
const RATE_LIMIT_PER_MINUTE = env('RATE_LIMIT_PER_MINUTE', 60);

// Do not keep decoded images cached between requests.
sharp.cache(false);

const OUTPUT_FORMATS = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
  avif: { ext: 'avif', mime: 'image/avif' },
  gif: { ext: 'gif', mime: 'image/gif' },
  tiff: { ext: 'tiff', mime: 'image/tiff' },
};

// Formats sharp can decode with its prebuilt binaries. AVIF reports as "heif".
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'gif', 'tiff', 'svg']);

// Output formats that can keep animation frames from GIF/WebP input.
const ANIMATED_OUTPUTS = new Set(['gif', 'webp']);

// Formats without an alpha channel need a background to flatten onto.
const OPAQUE_OUTPUTS = new Set(['jpeg']);

// Which output to use when the user asks to keep the original format.
const KEEP_FORMAT = { heif: 'avif', svg: 'png' };

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Applies the encoder for `format`.
 * - palette: PNG only. Reduce to an indexed palette of `colours` (much smaller, but lossy).
 * - fast: lower encoder effort, used while searching for the right quality.
 */
function encode(pipeline, format, quality, { palette = false, colours = 256, fast = false } = {}) {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, mozjpeg: true });
    case 'png':
      return palette
        ? pipeline.png({ compressionLevel: 9, palette: true, quality: 100, colours, dither: 1, effort: 10 })
        : pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    case 'webp':
      return pipeline.webp({ quality, effort: fast ? 4 : 6 });
    case 'avif':
      return pipeline.avif({ quality, effort: fast ? 2 : 4 });
    case 'gif':
      return pipeline.gif({ effort: 10, colours });
    case 'tiff':
      return pipeline.tiff({ compression: 'lzw' });
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

// Compression levels are visual targets, not fixed quality numbers. For each image we
// look for the smallest file whose similarity score (see lib/similarity.js) stays at or
// above the target, so an image that was already compressed is not pushed into visible
// artefacts. Thresholds were calibrated on real photos:
//   >= 0.985  indistinguishable even when zoomed in
//   >= 0.96   no visible difference at normal viewing size
//   >= 0.93   slight softening of fine texture when zoomed in
const LEVELS = {
  light: { target: 0.985, minQ: 60, maxQ: 95, pngColours: [256], fixedQ: 90 },
  recommended: { target: 0.96, minQ: 45, maxQ: 92, pngColours: [256], fixedQ: 80 },
  strong: { target: 0.93, minQ: 30, maxQ: 90, pngColours: [128, 256], fixedQ: 65 },
};
const LOSSY_FORMATS = new Set(['jpeg', 'webp', 'avif']);
const FAST_SEARCH_FORMATS = new Set(['avif']); // slowest encoder: search at low effort, then encode properly once

/** Returns { output, quality?, meetsTarget }. */
async function compressToTarget(pipeline, format, levelName, animated) {
  const level = LEVELS[levelName];

  if (format === 'tiff') {
    return { output: await encode(pipeline.clone(), 'tiff').toBuffer(), meetsTarget: true };
  }
  if (format === 'gif') {
    const colours = levelName === 'strong' ? 128 : 256;
    return { output: await encode(pipeline.clone(), 'gif', 0, { colours }).toBuffer(), meetsTarget: true };
  }
  if (animated) {
    // Frame-by-frame scoring is not worth the cost. Use a safe fixed quality.
    const output = await encode(pipeline.clone(), format, level.fixedQ).toBuffer();
    return { output, quality: level.fixedQ, meetsTarget: true };
  }

  const reference = await createReference(pipeline);

  if (format === 'png') {
    // Try palette reduction first. Use it only if it does not visibly band or speckle.
    for (const colours of level.pngColours) {
      const output = await encode(pipeline.clone(), 'png', 100, { palette: true, colours }).toBuffer();
      if ((await reference.score(output)) >= level.target) return { output, meetsTarget: true };
    }
    // Otherwise lossless PNG: smaller where possible, pixel-identical.
    return { output: await encode(pipeline.clone(), 'png', 100).toBuffer(), meetsTarget: true };
  }

  // Lossy formats: binary-search for the lowest quality that still meets the target.
  const fast = FAST_SEARCH_FORMATS.has(format);
  const attempt = async (q) => {
    const output = await encode(pipeline.clone(), format, q, { fast }).toBuffer();
    return { output, passes: (await reference.score(output)) >= level.target };
  };

  const top = await attempt(level.maxQ);
  if (!top.passes) {
    // Even the highest quality differs visibly (unusual). Report it so the caller can keep the original.
    return { output: top.output, quality: level.maxQ, meetsTarget: false };
  }

  let best = { q: level.maxQ, output: top.output };
  let lo = level.minQ;
  let hi = level.maxQ - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const result = await attempt(mid);
    if (result.passes) {
      best = { q: mid, output: result.output };
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const output = fast ? await encode(pipeline.clone(), format, best.q).toBuffer() : best.output;
  return { output, quality: best.q, meetsTarget: true };
}

/** Exact, user-chosen quality. No searching and no automatic lowering. */
async function compressAtQuality(pipeline, format, quality) {
  const options = {
    palette: format === 'png' && quality < 100,
    colours: format === 'gif' || format === 'png' ? Math.max(16, Math.round((256 * quality) / 100)) : 256,
  };
  const output = await encode(pipeline.clone(), format, quality, options).toBuffer();
  return { output, quality: LOSSY_FORMATS.has(format) ? quality : undefined, meetsTarget: true };
}

const MAX_DIMENSION = 10000;

/** Width/height after EXIF rotation, and per frame for animated images. */
function displaySize(meta) {
  const height = meta.pageHeight || meta.height;
  return (meta.orientation || 1) >= 5 ? { width: height, height: meta.width } : { width: meta.width, height };
}

/**
 * Builds sharp resize options for the Resize tool from the form fields:
 *   by: 'pixels' | 'percent'
 *   width, height (pixels), percent (1-400)
 *   fit: 'keep' (fit inside, keep proportions) | 'crop' (fill exact size, crop overflow) | 'stretch'
 *   enlarge: 'true' to allow making small images bigger
 * Returns { options } or { error }.
 */
function resizeOptions(body, meta, animated) {
  const src = displaySize(meta);
  const withoutEnlargement = body.enlarge !== 'true';

  if (body.by === 'percent') {
    const percent = Number.parseFloat(body.percent);
    if (!(percent > 0 && percent <= 400)) return { error: 'Enter a percentage between 1 and 400.' };
    const width = Math.max(1, Math.round((src.width * percent) / 100));
    const height = Math.max(1, Math.round((src.height * percent) / 100));
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return { error: `The result would be larger than ${MAX_DIMENSION} px.` };
    }
    return { options: { width, height, fit: 'fill', withoutEnlargement } };
  }

  let width = clampInt(body.width, 1, MAX_DIMENSION, 0) || null;
  let height = clampInt(body.height, 1, MAX_DIMENSION, 0) || null;
  const fit = body.fit || 'keep';

  if (fit === 'keep') {
    if (!width && !height) return { error: 'Enter a width, a height, or both.' };
    return { options: { width, height, fit: 'inside', withoutEnlargement } };
  }
  if (!width || !height) return { error: 'Cropping or stretching needs both a width and a height.' };

  // Exact sizes larger than the image: when enlarging isn't allowed, keep the requested
  // shape (e.g. square) at the largest size that fits, rather than skipping the resize.
  if (withoutEnlargement && (width > src.width || height > src.height)) {
    const scale = Math.min(src.width / width, src.height / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  if (fit === 'crop') {
    // Smart crop keeps the most detailed, eye-catching region. Animated images use the centre.
    const position = animated ? 'centre' : sharp.strategy.attention;
    return { options: { width, height, fit: 'cover', position, withoutEnlargement } };
  }
  if (fit === 'stretch') return { options: { width, height, fit: 'fill', withoutEnlargement } };
  return { error: `Unknown fit "${fit}".` };
}

/** Pixel count that `options` will produce from an image of size `src`. */
function estimateResizedPixels(options, src) {
  const { width, height, fit, withoutEnlargement } = options;
  if (fit === 'inside') {
    let scale = Math.min(width ? width / src.width : Infinity, height ? height / src.height : Infinity);
    if (withoutEnlargement) scale = Math.min(scale, 1);
    return Math.round(src.width * scale) * Math.round(src.height * scale);
  }
  if (withoutEnlargement && fit === 'fill') return Math.min(width, src.width) * Math.min(height, src.height);
  return width * height;
}

function outputName(originalName, ext) {
  const base = path.parse(originalName || 'image').name || 'image';
  return `${base}.${ext}`;
}

async function processImage(req, res, mode) {
  if (!req.file) {
    return res.status(400).json({ error: 'No image was uploaded.' });
  }

  const input = req.file.buffer;

  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return res.status(400).json({ error: 'This file could not be read as an image.' });
  }

  if (!INPUT_FORMATS.has(meta.format)) {
    return res.status(415).json({ error: `Input format "${meta.format}" is not supported.` });
  }

  const inputPixels = (meta.width || 0) * (meta.pageHeight || meta.height || 0) * (meta.pages || 1);
  if (inputPixels > MAX_PIXELS) {
    const mp = (n) => Math.round(n / 1e6);
    return res.status(413).json({
      error: `This image is too large (${mp(inputPixels)} megapixels). The limit is ${mp(MAX_PIXELS)} megapixels.`,
    });
  }

  const quality = clampInt(req.body.quality, 1, 100, 90);
  // Compress: a named level (visual target), or an exact custom quality when only `quality` is sent.
  const level = LEVELS[req.body.level] ? req.body.level : req.body.quality ? null : 'recommended';
  const maxWidth = clampInt(req.body.maxWidth, 1, 20000, 0);
  const maxHeight = clampInt(req.body.maxHeight, 1, 20000, 0);

  let format = (req.body.format || 'original').toLowerCase();
  if (format === 'jpg') format = 'jpeg';
  if (format === 'original') format = KEEP_FORMAT[meta.format] || meta.format;
  if (!OUTPUT_FORMATS[format]) {
    return res.status(400).json({ error: `Output format "${format}" is not supported.` });
  }

  const animated = ANIMATED_OUTPUTS.has(format) && (meta.pages || 1) > 1;

  let resize = null;
  if (mode === 'resize') {
    const parsed = resizeOptions(req.body, meta, animated);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    resize = parsed.options;
    const frames = animated ? meta.pages || 1 : 1;
    if (estimateResizedPixels(resize, displaySize(meta)) * frames > MAX_PIXELS) {
      return res.status(400).json({ error: 'The resized image would be too large. Try a smaller size.' });
    }
  } else if (maxWidth || maxHeight) {
    resize = { width: maxWidth || null, height: maxHeight || null, fit: 'inside', withoutEnlargement: true };
  }

  let output;
  let qualityUsed = LOSSY_FORMATS.has(format) ? quality : undefined;
  let meetsTarget = true;
  try {
    let pipeline = sharp(input, { animated, limitInputPixels: MAX_PIXELS }).rotate(); // apply EXIF orientation, then drop metadata

    if (resize) pipeline = pipeline.resize(resize);

    if (OPAQUE_OUTPUTS.has(format)) {
      pipeline = pipeline.flatten({ background: req.body.background || '#ffffff' });
    }

    if (mode === 'resize') {
      const result = await compressToTarget(pipeline, format, 'light', animated);
      output = result.output;
      qualityUsed = result.quality;
    } else if (mode === 'compress') {
      const result = level
        ? await compressToTarget(pipeline, format, level, animated)
        : await compressAtQuality(pipeline, format, quality);
      ({ output, meetsTarget } = result);
      qualityUsed = result.quality;
    } else {
      output = await encode(pipeline, format, quality).toBuffer();
    }
  } catch (err) {
    console.error('Processing failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong while processing this image.' });
  }

  // When compressing in the same format without resizing, never return a bigger file,
  // or one that would look visibly worse than the original.
  let note = '';
  const sameFormat = format === meta.format;
  if (
    mode === 'compress' &&
    sameFormat &&
    !maxWidth &&
    !maxHeight &&
    (output.length >= input.length || !meetsTarget)
  ) {
    output = input;
    note = 'already-optimized';
  }

  const { ext, mime } = OUTPUT_FORMATS[format];
  const filename = outputName(req.file.originalname, ext);
  const inSize = displaySize(meta);
  const outSize = note ? inSize : displaySize(await sharp(output).metadata());

  res.set({
    'Content-Type': mime,
    'Content-Length': output.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Filename': encodeURIComponent(filename),
    'X-Original-Size': input.length,
    'X-Output-Size': output.length,
    'X-Note': note,
    'X-Quality': note || !qualityUsed ? '' : String(qualityUsed),
    'X-Original-Width': inSize.width,
    'X-Original-Height': inSize.height,
    'X-Width': outSize.width,
    'X-Height': outSize.height,
    'Cache-Control': 'no-store',
  });
  return res.send(output);
}

// ---------- Job queue ----------
// Limits how many images are processed at once. The slot is taken before the upload is
// read, so queued requests wait with their upload still unread on the network rather
// than buffered in memory.
let activeJobs = 0;
const waitingJobs = [];

function acquireJobSlot() {
  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs++;
    return Promise.resolve();
  }
  if (waitingJobs.length >= MAX_QUEUED_JOBS) return null;
  return new Promise((resolve) => waitingJobs.push(resolve));
}

function releaseJobSlot() {
  const next = waitingJobs.shift();
  if (next) next(); // hand the slot straight to the next request
  else activeJobs--;
}

function jobSlot(req, res, next) {
  const slot = acquireJobSlot();
  if (!slot) {
    return res.status(503).json({ error: 'The server is busy right now. Please try again in a minute.' });
  }
  let granted = false;
  let closed = false;
  res.on('close', () => {
    closed = true;
    if (granted) releaseJobSlot();
  });
  slot.then(() => {
    granted = true;
    if (closed) releaseJobSlot(); // the visitor left while waiting
    else next();
  });
}

// ---------- App ----------
// Behind a hosting proxy (Render, Fly, etc.) set TRUST_PROXY=1 so rate limiting sees real visitor IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', env('TRUST_PROXY', 1));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { 'img-src': ["'self'", 'data:', 'blob:'] }, // thumbnails are blob: URLs
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many images at once. Please wait a minute and try again.' },
});

for (const mode of ['convert', 'compress', 'resize']) {
  app.post(`/api/${mode}`, apiLimiter, jobSlot, upload.single('file'), (req, res, next) =>
    processImage(req, res, mode).catch(next)
  );
}

// Upload errors (file too large, etc.)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is too large. The limit is ${MAX_FILE_SIZE / 1024 / 1024} MB.`
        : err.message;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`Pixelpress running at http://localhost:${PORT}`);
  console.log(`Limits: ${MAX_CONCURRENT_JOBS} jobs at once, ${MAX_QUEUED_JOBS} queued, ${RATE_LIMIT_PER_MINUTE} requests/min per IP`);
});

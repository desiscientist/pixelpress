// Measures how close a compressed image looks to the original, using SSIM
// (structural similarity) on the brightness channel. The eye is most sensitive to
// brightness detail, and that is where compression artefacts like blocking, ringing
// and smearing show up.
//
// The score is 1.0 for identical images and drops as visible differences appear.
// Averaging over the whole image would hide a badly damaged area (text, a face)
// behind a large clean sky, so the score blends the average with the worst 5% of the
// image.

const sharp = require('sharp');

const WINDOW = 8; // 8x8 windows...
const STRIDE = 4; // ...overlapping, so they straddle JPEG's 8x8 block edges where blocking shows.
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const MAX_ANALYSIS_PIXELS = 4_000_000; // bigger images are measured at about 4 MP to keep it fast

/** Converts an encoded image (or a sharp pipeline) into raw 8-bit luma at a fixed size. */
async function toLuma(source, width, height) {
  const img = typeof source.clone === 'function' ? source.clone() : sharp(source);
  const { data, info } = await img
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) throw new Error('Expected a single channel');
  return data;
}

function analysisSize(width, height) {
  const pixels = width * height;
  if (pixels <= MAX_ANALYSIS_PIXELS) return { width, height };
  const scale = Math.sqrt(MAX_ANALYSIS_PIXELS / pixels);
  return { width: Math.max(WINDOW, Math.round(width * scale)), height: Math.max(WINDOW, Math.round(height * scale)) };
}

/** SSIM over overlapping windows. Returns { mean, worst } where worst is the mean of the lowest 5%. */
function ssim(a, b, width, height) {
  const scores = [];
  const n = WINDOW * WINDOW;
  for (let y = 0; y + WINDOW <= height; y += STRIDE) {
    for (let x = 0; x + WINDOW <= width; x += STRIDE) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let dy = 0; dy < WINDOW; dy++) {
        let i = (y + dy) * width + x;
        for (let dx = 0; dx < WINDOW; dx++, i++) {
          const va = a[i];
          const vb = b[i];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const varA = saa / n - ma * ma;
      const varB = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      scores.push(((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (varA + varB + C2)));
    }
  }
  if (!scores.length) return { mean: 1, worst: 1 };

  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const sorted = Float64Array.from(scores).sort();
  const k = Math.max(1, Math.floor(sorted.length * 0.05));
  let worstSum = 0;
  for (let i = 0; i < k; i++) worstSum += sorted[i];
  return { mean, worst: worstSum / k };
}

/**
 * Prepares a reference from the original (after any resize/rotate), so that many
 * candidates can be scored against it cheaply.
 */
async function createReference(pipeline) {
  const full = await pipeline.clone().removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = analysisSize(full.info.width, full.info.height);
  const luma =
    width === full.info.width && height === full.info.height ? full.data : await toLuma(pipeline, width, height);
  return {
    width,
    height,
    /** Score 0..1 for an encoded candidate: a blend of the average and the worst 5%. */
    async score(candidate) {
      const other = await toLuma(candidate, width, height);
      const { mean, worst } = ssim(luma, other, width, height);
      return 0.5 * mean + 0.5 * worst;
    },
  };
}

module.exports = { createReference, ssim };

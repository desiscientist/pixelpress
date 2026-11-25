# Pixelpress

A web app that converts, compresses and resizes images.

- **Convert:** JPG, PNG, WebP, AVIF, GIF, TIFF and SVG input, to JPG, PNG, WebP, AVIF, GIF or TIFF.
- **Compress:** Light, Recommended or Strong, or an exact custom quality. You can keep the format or switch to WebP, AVIF or JPG, and optionally resize.
  Each level is a visual target, not a fixed quality number. For each image, the server searches for the smallest file whose similarity score (SSIM, see `lib/similarity.js`) stays above the level's target. Images that can't shrink without visible loss are returned unchanged. PNGs are only reduced to a palette when that doesn't visibly band. Otherwise they are saved losslessly.
- **Resize:** by pixels (keep proportions, smart-crop to an exact size, or stretch) or by percentage, with an optional "don't enlarge" setting. Resized images are saved at the Light visual target, so resizing adds no visible compression loss.
- Batch processing, before and after sizes, and a "Download all" zip.
- Images are processed in memory with [sharp](https://sharp.pixelplumbing.com/) and never written to disk.

## Run

```bash
npm install
npm start        # http://localhost:3000
npm run dev      # restarts on server changes
```

Set `PORT` to use a different port.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/desiscientist/pixelpress)

`render.yaml` sets up a free Render web service that redeploys on every push to `main`. The free plan sleeps after 15 minutes without visits, so the first visit after that takes about a minute to wake up.

Settings for a public server (environment variables):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_CONCURRENT_JOBS` | 2 (1 on Render free) | Images processed at the same time. Others wait in a queue |
| `MAX_QUEUED_JOBS` | 30 | Requests allowed to wait. Beyond this, visitors get "server busy" |
| `RATE_LIMIT_PER_MINUTE` | 60 | Requests per minute per visitor IP |
| `MAX_PIXELS` | 50000000 | Largest image (input or resized output) in pixels. Blocks decompression bombs |
| `TRUST_PROXY` | off (1 on Render) | Set when running behind a proxy so rate limiting sees real IPs |

## API

`POST /api/convert`, `POST /api/compress` and `POST /api/resize` take `multipart/form-data`:

| Field       | Applies to | Notes |
|-------------|------------|-------|
| `file`      | both       | The image, up to 25 MB |
| `format`    | both       | `jpeg`, `png`, `webp`, `avif`, `gif`, `tiff`, or `original` (compress default) |
| `level`     | compress   | `light`, `recommended` (default) or `strong`. Visual targets: similarity ≥ 0.985 / 0.96 / 0.93 |
| `quality`   | both       | 1–100. Convert default 90. For compress, sending `quality` without `level` uses that exact quality |
| `maxWidth`, `maxHeight` | both | Optional. Shrinks the image to fit, never enlarges it |
| `by`        | resize     | `pixels` (default) or `percent` |
| `width`, `height` | resize | Target size in px (1–10000). With `fit=keep`, one may be left out |
| `fit`       | resize     | `keep` (fit inside, default), `crop` (fill and smart-crop) or `stretch`. `crop` and `stretch` need both sizes |
| `percent`   | resize     | 1–400, when `by=percent` |
| `enlarge`   | resize     | `true` to allow upscaling smaller images. Default off |
| `background`| both       | Fill colour for transparent pixels when the output is JPG. Default `#ffffff` |

The response is the image itself. `X-Original-Size` / `X-Output-Size` give the file sizes, and `X-Original-Width`, `X-Original-Height`, `X-Width`, `X-Height` give the dimensions. `X-Note: already-optimized` means compression would have made the file bigger, so the original was returned.

## Layout

```
server.js          Express server and the sharp processing pipeline
lib/similarity.js  SSIM score used to pick the smallest file that still looks right
public/index.html  UI
public/styles.css
public/app.js      File handling, settings, upload queue (3 at a time)
public/zip.js      Small dependency-free zip writer for "Download all"
```

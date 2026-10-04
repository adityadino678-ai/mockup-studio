import type { FitMode, SafeFrame } from '../../types';

/**
 * Normalise a design to the shape of the print area before handing it to
 * Printify.
 *
 * This is what makes the listing match the preview. Printify only understands
 * "place this whole file, this wide, here, at this angle" — it has no notion of
 * a box to crop to. The editor shows the design *cropped or padded to the print
 * area*, so the file we upload has to already be in that shape.
 *
 *  - `cover`   centre-crop, the same crop the canvas preview shows
 *  - `contain` pad with transparency so the whole design stays visible
 *  - `stretch` resize to the exact shape, distorting like the preview does
 *
 * The output is padded up to at least `minEdgePx` on its shorter side, because
 * Printify rejects files it judges to be low resolution.
 */
export async function prepareArtwork(
  source: Blob,
  frame: SafeFrame,
  fit: FitMode,
  minEdgePx = 1000,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await loadImage(source);
  const sw = bitmap.width;
  const sh = bitmap.height;

  const frameAspect = frame.w / Math.max(frame.h, 1e-6);

  // Output canvas always matches the print area's shape.
  let outW: number;
  let outH: number;
  if (frameAspect >= 1) {
    outH = Math.max(minEdgePx, Math.round(minEdgePx / Math.max(frameAspect, 1e-6)));
    outW = Math.round(outH * frameAspect);
  } else {
    outW = Math.max(minEdgePx, Math.round(minEdgePx * frameAspect));
    outH = Math.round(outW / frameAspect);
  }
  outW = Math.max(1, outW);
  outH = Math.max(1, outH);

  // Source rect: how much of the original we take.
  let sx = 0;
  let sy = 0;
  let sWidth = sw;
  let sHeight = sh;
  if (fit === 'cover') {
    const sourceAspect = sw / Math.max(sh, 1e-6);
    if (sourceAspect > frameAspect) {
      sWidth = sh * frameAspect;
      sx = (sw - sWidth) / 2;
    } else {
      sHeight = sw / frameAspect;
      sy = (sh - sHeight) / 2;
    }
  }

  // Destination rect: where that piece lands inside the output canvas.
  let dx = 0;
  let dy = 0;
  let dWidth = outW;
  let dHeight = outH;
  if (fit === 'contain') {
    const sourceAspect = sw / Math.max(sh, 1e-6);
    if (sourceAspect > frameAspect) {
      dHeight = outW / sourceAspect;
      dy = (outH - dHeight) / 2;
    } else {
      dWidth = outH * sourceAspect;
      dx = (outW - dWidth) / 2;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas to prepare the artwork');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
  if (bitmap instanceof ImageBitmap) bitmap.close();

  const blob = await toPng(canvas);
  return { blob, width: outW, height: outH };
}

async function loadImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('That design file could not be decoded as an image'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the prepared artwork');
  return blob;
}

/** Base64 without the data-URL prefix, which is what the uploads API wants. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return btoa(binary);
}
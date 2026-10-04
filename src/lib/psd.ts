/**
 * Minimal PSD/PSB reader that pulls a usable raster preview out of a Photoshop
 * file, so blank PSD mockups can be dropped straight into the app.
 *
 * Preference order:
 *   1. The composite image data section (full resolution, raw or RLE, 8-bit).
 *   2. The embedded thumbnail image resource (JPEG) when there is no composite.
 *
 * Anything it does not understand yields `null` so the caller can skip that one
 * file instead of failing the whole batch.
 */

const MAX_EDGE = 8000;
const MAX_PIXELS = 64_000_000;

export const PSD_EXT_RE = /\.ps[db]$/i;

const SIG_8BPS = [0x38, 0x42, 0x50, 0x53];
const SIG_8BIM = 0x38_42_49_4d;

export interface Raster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

class Reader {
  pos = 0;
  constructor(readonly view: DataView) {}

  private need(n: number): boolean {
    return this.pos + n <= this.view.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }
  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 0x1_0000_0000 + lo;
  }
  skip(n: number): void {
    this.pos = Math.min(this.view.byteLength, this.pos + n);
  }
  bytes(n: number): Uint8Array | null {
    if (!this.need(n)) return null;
    const start = this.pos;
    this.pos += n;
    return new Uint8Array(this.view.buffer, this.view.byteOffset + start, n);
  }
  /** 4-byte section length, 8-byte for PSB. */
  length(isPsb: boolean): number {
    const n = isPsb ? this.u64() : this.u32();
    return Number.isFinite(n) ? n : -1;
  }
}

/** PackBits decode of exactly `out.length` bytes from `src`. */
function unpackRow(src: Uint8Array, out: Uint8Array): boolean {
  let i = 0;
  const end = src.length;
  let o = 0;
  while (i < end && o < out.length) {
    const n = src[i++];
    if (n === 128) continue;
    if (n < 128) {
      const len = n + 1;
      if (i + len > end) break;
      for (let k = 0; k < len; k++) out[o++] = src[i++];
    } else {
      const len = 257 - n;
      if (i >= end) break;
      const value = src[i++];
      for (let k = 0; k < len && o < out.length; k++) out[o++] = value;
    }
  }
  return o === out.length;
}

/** Interleave planar channel data into RGBA. */
function composeToRgba(
  width: number,
  height: number,
  planes: Uint8Array[],
  channelCount: number,
  colorMode: number,
  palette: Uint8Array | null,
): Uint8ClampedArray | null {
  const px = width * height;
  const out = new Uint8ClampedArray(px * 4);

  if (colorMode === 2) {
    if (!palette || planes.length < 1) return null;
    const idx = planes[0];
    for (let i = 0; i < px; i++) {
      const p = idx[i] * 3;
      out[i * 4] = palette[p];
      out[i * 4 + 1] = palette[p + 1];
      out[i * 4 + 2] = palette[p + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  if (colorMode === 1 || colorMode === 8) {
    const g = planes[0];
    if (!g) return null;
    const a = channelCount > 1 ? planes[1] : null;
    for (let i = 0; i < px; i++) {
      out[i * 4] = g[i];
      out[i * 4 + 1] = g[i];
      out[i * 4 + 2] = g[i];
      out[i * 4 + 3] = a ? a[i] : 255;
    }
    return out;
  }

  if (colorMode !== 3) return null; // CMYK and multi-channel are out of scope
  const [r, g, b] = planes;
  if (!r || !g || !b) return null;
  const a = channelCount > 3 ? planes[3] : null;
  for (let i = 0; i < px; i++) {
    out[i * 4] = r[i];
    out[i * 4 + 1] = g[i];
    out[i * 4 + 2] = b[i];
    out[i * 4 + 3] = a ? a[i] : 255;
  }
  return out;
}

function readComposite(
  r: Reader,
  width: number,
  height: number,
  channels: number,
  depth: number,
  colorMode: number,
  palette: Uint8Array | null,
): Raster | null {
  if (depth !== 8) return null;
  if (r.pos + 2 > r.view.byteLength) return null;
  const compression = r.u16();
  const px = width * height;
  const planes: Uint8Array[] = [];

  if (compression === 0) {
    for (let c = 0; c < channels; c++) {
      const plane = r.bytes(px);
      if (!plane) return null;
      planes.push(new Uint8Array(plane));
    }
  } else if (compression === 1) {
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(px);
      for (let row = 0; row < height; row++) {
        if (r.pos + 2 > r.view.byteLength) return null;
        const count = r.u16();
        const packed = r.bytes(count);
        if (!packed) return null;
        if (!unpackRow(packed, plane.subarray(row * width, (row + 1) * width))) return null;
      }
      planes.push(plane);
    }
  } else {
    return null;
  }

  const rgba = composeToRgba(width, height, planes, channels, colorMode, palette);
  return rgba ? { width, height, rgba } : null;
}

/** Locate a JPEG thumbnail inside the image resources block. */
function findThumbnail(resources: Uint8Array): Uint8Array | null {
  const view = new DataView(resources.buffer, resources.byteOffset, resources.byteLength);
  const r = new Reader(view);
  while (r.pos + 12 <= view.byteLength) {
    if (r.u32() !== SIG_8BIM) return null;
    const id = r.u16();
    const nameLength = r.u8();
    r.skip(nameLength + (nameLength % 2));
    if (r.pos + 4 > view.byteLength) return null;
    const size = r.u32();
    if (size < 0 || r.pos + size > view.byteLength) return null;
    if (id === 1036 || id === 1033) {
      const block = r.bytes(size);
      if (block && block.length > 4 && block[0] === 0xff && block[1] === 0xd8) return block;
    }
    r.skip(size + (size % 2));
  }
  return null;
}

function jpegToRaster(jpeg: Uint8Array): Promise<Raster | null> {
  const url = URL.createObjectURL(new Blob([jpeg.slice()], { type: 'image/jpeg' }));
  return new Promise((resolve) => {
    const img = new Image();
    const finish = (value: Raster | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return finish(null);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      finish({ width: canvas.width, height: canvas.height, rgba: data.data });
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

export function isPsdFile(file: File): boolean {
  return PSD_EXT_RE.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}

/** Extract a preview raster from a PSD/PSB file. Returns null if unsupported. */
export async function readPsdPreview(file: Blob): Promise<Raster | null> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return null;
  }

  const view = new DataView(buffer);
  if (view.byteLength < 26) return null;
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(i) !== SIG_8BPS[i]) return null;
  }

  const r = new Reader(view);
  r.skip(4);
  const version = r.u16();
  const isPsb = version === 2;
  r.skip(6);
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const colorMode = r.u16();

  if (width < 1 || height < 1) return null;
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) return null;

  // Colour mode data — holds the palette for indexed images.
  const cmLength = r.length(isPsb);
  if (cmLength < 0) return null;
  let palette: Uint8Array | null = null;
  if (cmLength > 0) {
    if (colorMode === 2 && cmLength >= 768) palette = r.bytes(768);
    else r.skip(cmLength);
  }

  // Image resources — remembered only if the composite turns out unusable.
  const resLength = r.length(false);
  if (resLength < 0) return null;
  let thumbnail: Uint8Array | null = null;
  if (resLength > 0) {
    const block = r.bytes(resLength);
    if (block) thumbnail = findThumbnail(block);
  }

  // Layer and mask information, then the composite.
  const layerLength = r.length(isPsb);
  if (layerLength < 0) return null;
  if (layerLength > 0) r.skip(layerLength);

  const composite = readComposite(r, width, height, channels, depth, colorMode, palette);
  if (composite) return composite;
  if (thumbnail) return jpegToRaster(thumbnail);
  return null;
}

export async function psdToPng(raster: Raster): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const pixels = new Uint8ClampedArray(raster.rgba);
  ctx.putImageData(new ImageData(pixels, raster.width, raster.height), 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode PSD preview'))),
      'image/png',
    ),
  );
}

/* Node-side sanity checks for the import pipeline. Run: npm run test:import */
import { readPsdPreview } from '../src/lib/psd';
import { isImportableFile, splitByKind } from '../src/lib/files';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

class W {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.parts.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  raw(bytes: number[]) {
    for (const b of bytes) this.parts.push(b & 0xff);
    return this;
  }
  build(): ArrayBuffer {
    return new Uint8Array(this.parts).buffer;
  }
}

interface PsdOptions {
  channels: number;
  width: number;
  height: number;
  colorMode: number;
  compression: 0 | 1;
  planes: number[][];
  /** encode RLE rows as byte runs (n >= 128) instead of literals */
  rleRun?: boolean;
}

/** PackBits-encode one row. */
function encodeRow(row: number[], asRun: boolean): number[] {
  const out: number[] = [];
  if (asRun) {
    let i = 0;
    while (i < row.length) {
      let len = 1;
      while (i + len < row.length && row[i + len] === row[i] && len < 128) len += 1;
      out.push(257 - len, row[i]);
      i += len;
    }
    return out;
  }
  for (let i = 0; i < row.length; i += 128) {
    const chunk = row.slice(i, i + 128);
    out.push(chunk.length - 1, ...chunk);
  }
  return out;
}

function buildPsd(o: PsdOptions): ArrayBuffer {
  const w = new W();
  w.raw([0x38, 0x42, 0x50, 0x53]); // 8BPS
  w.u16(1);
  for (let i = 0; i < 6; i++) w.u8(0);
  w.u16(o.channels);
  w.u32(o.height);
  w.u32(o.width);
  w.u16(8); // depth
  w.u16(o.colorMode);
  w.u32(0); // colour mode data
  w.u32(0); // image resources
  w.u32(0); // layer and mask
  w.u16(o.compression);
  for (const plane of o.planes) {
    if (o.compression === 0) {
      w.raw(plane);
    } else {
      for (let row = 0; row < o.height; row++) {
        const encoded = encodeRow(plane.slice(row * o.width, (row + 1) * o.width), o.rleRun === true);
        w.u16(encoded.length);
        w.raw(encoded);
      }
    }
  }
  return w.build();
}

async function main(): Promise<void> {
  console.log('PSD composite reader');

  // --- raw RGB ---
  const W4 = 4;
  const H3 = 3;
  const px = W4 * H3;
  const rPlane = Array.from({ length: px }, (_, i) => i);
  const gPlane = Array.from({ length: px }, (_, i) => 100 + i);
  const bPlane = Array.from({ length: px }, (_, i) => 200 + i);
  const rawPsd = new Blob([buildPsd({
    channels: 3, width: W4, height: H3, colorMode: 3, compression: 0,
    planes: [rPlane, gPlane, bPlane],
  })]);
  const rawOut = await readPsdPreview(rawPsd);
  check('raw RGB: dimensions', rawOut?.width === W4 && rawOut?.height === H3,
    `got ${rawOut?.width}x${rawOut?.height}`);
  check('raw RGB: length', rawOut?.rgba.length === px * 4);
  const d0 = rawOut?.rgba ?? new Uint8ClampedArray(0);
  check('raw RGB: pixel 0', d0[0] === 0 && d0[1] === 100 && d0[2] === 200 && d0[3] === 255,
    `got ${d0[0]},${d0[1]},${d0[2]},${d0[3]}`);
  const last = (px - 1) * 4;
  check('raw RGB: last pixel', d0[last] === px - 1 && d0[last + 1] === 100 + px - 1 && d0[last + 2] === 200 + px - 1,
    `got ${d0[last]},${d0[last + 1]},${d0[last + 2]}`);

  // --- RLE RGB, literal encoding ---
  const flat42 = new Array<number>(px).fill(42);
  const literalPsd = new Blob([buildPsd({
    channels: 3, width: W4, height: H3, colorMode: 3, compression: 1,
    planes: [flat42, flat42, flat42],
  })]);
  const literalOut = await readPsdPreview(literalPsd);
  check('rle literal: reads back', literalOut !== null);
  const l0 = literalOut?.rgba ?? new Uint8ClampedArray(0);
  check('rle literal: pixel 0', l0[0] === 42 && l0[1] === 42 && l0[2] === 42 && l0[3] === 255,
    `got ${l0[0]},${l0[1]},${l0[2]},${l0[3]}`);
  check('rle literal: last pixel', l0[(px - 1) * 4] === 42 && l0[(px - 1) * 4 + 3] === 255);

  // --- RLE RGB, byte-run encoding (n >= 128) ---
  const runPsd = new Blob([buildPsd({
    channels: 3, width: W4, height: H3, colorMode: 3, compression: 1, rleRun: true,
    planes: [flat42, flat42, flat42],
  })]);
  const runOut = await readPsdPreview(runPsd);
  check('rle run: reads back', runOut !== null);
  const u0 = runOut?.rgba ?? new Uint8ClampedArray(0);
  check('rle run: pixel 0', u0[0] === 42 && u0[1] === 42 && u0[2] === 42 && u0[3] === 255,
    `got ${u0[0]},${u0[1]},${u0[2]},${u0[3]}`);
  check('rle run: last pixel', u0[(px - 1) * 4] === 42 && u0[(px - 1) * 4 + 3] === 255);

  // --- RLE with a non-uniform row, to catch row-boundary mistakes ---
  const rampPlane = Array.from({ length: px }, (_, i) => i % W4);
  const rampPsd = new Blob([buildPsd({
    channels: 3, width: W4, height: H3, colorMode: 3, compression: 1,
    planes: [rampPlane, rampPlane, rampPlane],
  })]);
  const rampOut = await readPsdPreview(rampPsd);
  const q0 = rampOut?.rgba ?? new Uint8ClampedArray(0);
  let rampOk = true;
  for (let i = 0; i < px; i++) {
    if (q0[i * 4] !== i % W4) rampOk = false;
  }
  check('rle ramp: every pixel lands on the right row offset', rampOk);

  // --- greyscale + alpha ---
  const grayPlane = Array.from({ length: px }, (_, i) => i * 2);
  const alphaPlane = Array.from({ length: px }, (_, i) => 255 - i);
  const grayPsd = new Blob([buildPsd({
    channels: 2, width: W4, height: H3, colorMode: 1, compression: 0,
    planes: [grayPlane, alphaPlane],
  })]);
  const grayOut = await readPsdPreview(grayPsd);
  const g0 = grayOut?.rgba ?? new Uint8ClampedArray(0);
  check('greyscale: luminance replicated', g0[0] === 0 && g0[1] === 0 && g0[2] === 0);
  check('greyscale: alpha from second channel', g0[3] === 255);
  check('greyscale: alpha at last pixel', g0[(px - 1) * 4 + 3] === 255 - (px - 1),
    `got ${g0[(px - 1) * 4 + 3]}`);

  // --- rejections ---
  const notPsd = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])]);
  check('rejects non-PSD', (await readPsdPreview(notPsd)) === null);

  const truncated = new Blob([buildPsd({
    channels: 3, width: W4, height: H3, colorMode: 3, compression: 0,
    planes: [rPlane, gPlane, bPlane],
  }).slice(0, 40)]);
  check('rejects truncated file without throwing', (await readPsdPreview(truncated)) === null);

  const cmyk = new Blob([buildPsd({
    channels: 4, width: W4, height: H3, colorMode: 4, compression: 0,
    planes: [rPlane, gPlane, bPlane, flat42],
  })]);
  check('CMYK returns null instead of garbage', (await readPsdPreview(cmyk)) === null);

  console.log('\nFile classification');
  const fake = (name: string, type = '') => ({ name, type }) as File;
  check('accepts png', isImportableFile(fake('a.png', 'image/png')));
  check('accepts psd', isImportableFile(fake('blank.psd')));
  check('accepts psb', isImportableFile(fake('blank.psb')));
  check('rejects ai', !isImportableFile(fake('art.ai')));
  check('rejects zip', !isImportableFile(fake('pack.zip')));
  check('rejects mp4', !isImportableFile(fake('turntable.mp4', 'video/mp4')));

  const split = splitByKind([
    fake('tshirt-blank-mockup.png', 'image/png'),
    fake('logo-final.png', 'image/png'),
    fake('mug.psd'),
  ]);
  check('split routes mockup', split.mockups.length === 2, JSON.stringify(split.mockups.map((f) => f.name)));
  check('split routes design', split.designs.length === 1, JSON.stringify(split.designs.map((f) => f.name)));

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

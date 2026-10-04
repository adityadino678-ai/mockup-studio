/**
 * On-device background removal for imported designs.
 *
 * Runs the imgly ISNet segmentation model through onnxruntime-web, so artwork
 * never leaves the machine: the wasm runtime and the model weights are fetched
 * once from the imgly CDN and then served from the browser's HTTP cache.
 *
 * The very first removal in a session therefore pays for a ~54 MB download
 * (11 MB of wasm plus 42 MB of quantised weights) before it can start working,
 * so the UI has to say so. Everything is reached through a single
 * lazily-imported module promise, and the per-image work runs strictly one at a
 * time — the wasm runtime is already multi-threaded, so overlapping inferences
 * only thrash.
 */

/**
 * Weights shipped by imgly, smallest first. The quantised model is the default
 * because it halves the one-off download and still holds up on the flat artwork
 * this app is built for; `isnet_fp16` (84 MB) and `isnet` (168 MB) trade download
 * size for slightly cleaner edges on photographic subjects.
 */
export type BgModel = 'isnet_quint8' | 'isnet_fp16' | 'isnet';

export const DEFAULT_MODEL: BgModel = 'isnet_quint8';

export interface BgProgress {
  /** Human readable phase, e.g. "Downloading the AI model" or "Separating the subject". */
  label: string;
  /** 0..1 */
  value: number;
}

export interface RemoveOptions {
  model?: BgModel;
  onProgress?: (progress: BgProgress) => void;
}

type BgModule = typeof import('@imgly/background-removal');

let modulePromise: Promise<BgModule> | null = null;

function loadModule(): Promise<BgModule> {
  modulePromise ??= import('@imgly/background-removal');
  return modulePromise;
}

export function isSupported(): boolean {
  return typeof WebAssembly === 'object';
}

function config(model: BgModel, onProgress?: (p: BgProgress) => void) {
  return {
    model,
    output: { format: 'image/png' as const, quality: 1 },
    device: (typeof navigator !== 'undefined' && 'gpu' in navigator ? 'gpu' : 'cpu') as 'gpu' | 'cpu',
    progress: (key: string, current: number, total: number) => {
      if (!onProgress || total <= 0) return;
      onProgress({
        label: key === 'compute:inference' ? 'Separating the subject' : 'Downloading the AI model',
        value: Math.min(1, current / total),
      });
    },
  };
}

/** Fraction of pixels that are not fully opaque, 0..1. */
function transparency(blob: Blob): Promise<number> {
  return createImageBitmap(blob)
    .then((bitmap) => {
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 64;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return 0;
      ctx.drawImage(bitmap, 0, 0, 64, 64);
      const { data } = ctx.getImageData(0, 0, 64, 64);
      let clear = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear += 1;
      return clear / (data.length / 4);
    })
    .catch(() => 0);
}

/**
 * Cut the subject out of one image.
 *
 * Images that already carry a real alpha channel are returned untouched: they
 * have been cut out before and running the model again would only chew the
 * existing soft edges.
 */
export async function removeBackground(blob: Blob, options: RemoveOptions = {}): Promise<Blob> {
  if (!isSupported()) throw new Error('this browser cannot run the background remover');
  if (await transparency(blob) > 0.02) return blob;

  const bg = await loadModule();
  const result = await bg.removeBackground(blob, config(options.model ?? DEFAULT_MODEL, options.onProgress));
  if (!result.size) throw new Error('the remover returned an empty image');
  return result;
}

export interface StripResult<T> {
  items: T[];
  /** Items that kept their original bytes because removal failed. */
  skipped: { name: string; reason: string }[];
}

/**
 * Remove backgrounds from a batch, one image at a time.
 *
 * Failures are per-image and never abort the batch: a design whose background
 * could not be cut is still imported, just with its original background. Items
 * that go through the model come back flagged with `bgRemoved`, and items that
 * already had real transparency are left completely alone.
 */
export async function stripBackgrounds<T extends { name: string; blob: Blob; bgRemoved?: boolean }>(
  items: T[],
  options: RemoveOptions = {},
): Promise<StripResult<T>> {
  const out: T[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const prefix = `Removing background ${i + 1} of ${items.length}`;
    options.onProgress?.({ label: prefix, value: 0 });
    try {
      const blob = await removeBackground(item.blob, {
        model: options.model,
        onProgress: (p) => options.onProgress?.({ label: `${prefix} · ${p.label}`, value: p.value }),
      });
      out.push(blob === item.blob ? item : { ...item, blob, bgRemoved: true });
    } catch (error) {
      skipped.push({ name: item.name, reason: reason(error) });
      out.push(item);
    }
  }

  return { items: out, skipped };
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|Failed to load|load timeout/i.test(message)) {
    return 'could not download the AI model — check your connection';
  }
  return message;
}

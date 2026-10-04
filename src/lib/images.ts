import type { LoadedImage } from '../types';
import { loadBlob } from './db';

interface Entry {
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<LoadedImage>>();

function decode(blob: Blob): Promise<LoadedImage> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () =>
      resolve({ url, image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image'));
    };
    image.src = url;
  });
}

/** Load (and memoise) a decoded image for an IndexedDB blob key. */
export function getImage(key: string): Promise<LoadedImage> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = loadBlob(key)
    .then((blob) => {
      if (!blob) throw new Error(`Missing blob for ${key}`);
      return decode(blob);
    })
    .then((loaded) => {
      cache.set(key, loaded);
      inflight.delete(key);
      return loaded;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, task);
  return task;
}

export function peekImage(key: string): LoadedImage | undefined {
  return cache.get(key);
}

/** Synchronously warm many keys without awaiting each one. */
export function preloadImages(keys: string[]): void {
  for (const key of keys) {
    if (!cache.has(key) && !inflight.has(key)) void getImage(key).catch(() => {});
  }
}

export function revokeAll(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
}

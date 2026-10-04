import { uid } from './id';
import { isPsdFile, psdToPng, readPsdPreview } from './psd';

export interface Ingested {
  name: string;
  blobKey: string;
  blob: Blob;
  width: number;
  height: number;
  /** Set once the background remover has produced a cut-out version. */
  bgRemoved?: boolean;
}

export interface ImportFailure {
  name: string;
  reason: string;
}

export interface ImportResult {
  added: Ingested[];
  failed: ImportFailure[];
}

const RASTER_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
const SKIP_RE = /\.(psd|psb|ai|eps|indd|sketch|fig|afdesign|afphoto|zip|rar|7z|mp4|mov|psb1|xmp|json|txt)$/i;

export function isImportableFile(file: File): boolean {
  if (isPsdFile(file)) return true;
  if (SKIP_RE.test(file.name)) return false;
  return file.type.startsWith('image/') || RASTER_RE.test(file.name);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 80) || 'untitled';
}

function measure(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('browser cannot decode this format'));
    };
    img.src = url;
  });
}

function friendlyReason(file: File, error: unknown): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const message = error instanceof Error ? error.message : String(error);
  if (/decode/i.test(message)) {
    if (ext === 'heic' || ext === 'heif') return 'HEIC is not supported — convert to PNG or JPG first';
    if (ext === 'tif' || ext === 'tiff') return 'TIFF is not supported by browsers — convert to PNG first';
    return 'not a readable image, or the file is corrupted';
  }
  return message;
}

async function convertOne(file: File): Promise<Ingested> {
  let blob: Blob = file;
  let width = 0;
  let height = 0;

  if (isPsdFile(file)) {
    const raster = await readPsdPreview(file);
    if (!raster) throw new Error('no usable preview inside this Photoshop file');
    blob = await psdToPng(raster);
    width = raster.width;
    height = raster.height;
  }

  if (!width || !height) {
    const size = await measure(blob);
    width = size.width;
    height = size.height;
  }

  if (!width || !height) throw new Error('image has zero dimensions');

  return {
    name: stripExt(file.name),
    blobKey: uid('blob'),
    blob,
    width,
    height,
  };
}

/**
 * Import a batch of files. Each file is handled independently so one bad file
 * never discards the rest of the drop.
 */
export async function ingestFiles(files: File[], concurrency = 4): Promise<ImportResult> {
  const candidates = files.filter(isImportableFile);
  const added: Ingested[] = [];
  const failed: ImportFailure[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      const file = candidates[index];
      try {
        added.push(await convertOne(file));
      } catch (error) {
        failed.push({ name: file.name, reason: friendlyReason(file, error) });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );

  added.sort((a, b) => a.name.localeCompare(b.name));
  return { added, failed };
}

/** Pull files out of a drop event, including dragged folders where supported. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === 'file' ? (item.webkitGetAsEntry?.() ?? null) : null))
    .filter((e): e is FileSystemEntry => Boolean(e));

  if (entries.length === 0) return Array.from(dt.files ?? []);

  const walk = async (entry: FileSystemEntry, depth = 0): Promise<void> => {
    if (depth > 8) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  };

  for (const entry of entries) await walk(entry);
  return out.length ? out : Array.from(dt.files ?? []);
}

export function splitByKind(files: File[]): { designs: File[]; mockups: File[] } {
  const designs: File[] = [];
  const mockups: File[] = [];
  for (const file of files) {
    if (/mock|blank|scene|product|psd|psb|mockup|pack/i.test(file.name)) mockups.push(file);
    else designs.push(file);
  }
  return { designs, mockups };
}

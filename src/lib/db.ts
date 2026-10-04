import type { PrintifyConfig, Project } from '../types';
import { DEFAULT_FRAME } from './geometry';

/** Starting values for projects created before the Printify panel existed. */
export const DEFAULT_PRINTIFY_CONFIG: PrintifyConfig = {
  shopId: null,
  blueprintId: null,
  printProviderId: null,
  templateProductId: null,
  colourSides: {},
  shortlist: [],
  price: 2671,
  titleTemplate: '{design} | {positions}',
  descriptionTemplate: '',
  tagsTemplate: '',
  safetyTemplate: '',
};

/**
 * Persistence, on a single object store with prefixed keys.
 *
 * This used to be two object stores in one database via idb-keyval. That cannot
 * work: idb-keyval creates only the store named in `createStore` when it first
 * opens a database, and `onupgradeneeded` does not fire again at the same
 * version, so the second store never existed and every write to it threw
 * "One of the specified object stores was not found". The schema is therefore
 * owned explicitly here, with a version bump that also clears the dead stores
 * an earlier build left behind.
 *
 * Keys are `blob:<id>` for images and `proj:<id>` for project documents.
 */

const DB_NAME = 'mockup-studio';
const DB_VERSION = 3;
const STORE_NAME = 'kv';
const BLOB_PREFIX = 'blob:';
const PROJECT_PREFIX = 'proj:';

/** Stores written by the broken two-store build; safe to discard. */
const LEGACY_STORES = ['projects', 'blobs'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of LEGACY_STORES) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading must not leave us holding a stale connection.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () =>
      reject(new Error('Close other tabs of this app so it can upgrade its storage'));
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

function request<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE_NAME, mode);
        } catch (error) {
          reject(error);
          return;
        }
        const req = run(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

/** A write whose result value is irrelevant. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function write(run: (store: IDBObjectStore) => IDBRequest<any>): Promise<void> {
  return request<any>('readwrite', run).then(() => undefined);
}

export const blobKey = (key: string): string => `${BLOB_PREFIX}${key}`;
export const projectKey = (id: string): string => `${PROJECT_PREFIX}${id}`;

export function saveBlob(key: string, blob: Blob): Promise<void> {
  return write((store) => store.put(blob, blobKey(key)));
}

export function loadBlob(key: string): Promise<Blob | undefined> {
  return request<Blob | undefined>('readonly', (store) => store.get(blobKey(key)));
}

export function deleteBlob(key: string): Promise<void> {
  return write((store) => store.delete(blobKey(key)));
}

export function saveProject(project: Project): Promise<void> {
  return write((store) => store.put(project, projectKey(project.id)));
}

/**
 * Fill in fields added after a project was first saved, so projects written by an
 * older build stay usable. Existing placements are left exactly where the user
 * put them: `linkedToFrame` starts false, which stops the migration from moving
 * anything that was already placed by hand.
 */
export function migrateProject(project: Project): Project {
  const frame = project.frame ?? { ...DEFAULT_FRAME };
  // Frames saved before rotation existed keep working, just unrotated.
  project.frame = frame.rotation === undefined ? { ...frame, rotation: 0 } : frame;
  if (project.frameLocked === undefined) project.frameLocked = true;
  // Printify settings arrived after these projects were first saved.
  project.printify = { ...DEFAULT_PRINTIFY_CONFIG, ...(project.printify ?? {}) };
  for (const design of project.designs) {
    if (design.printPositions === undefined) design.printPositions = ['front'];
  }
  for (const mockup of project.mockups) {
    const override = mockup.frameOverride;
    mockup.frameOverride =
      override === undefined || override === null
        ? null
        : override.rotation === undefined
          ? { ...override, rotation: 0 }
          : override;
    for (const [designId, placement] of Object.entries(mockup.placements)) {
      if (placement.fit === undefined) placement.fit = 'cover';
      if (placement.linkedToFrame === undefined) placement.linkedToFrame = false;
      if (placement.designId === undefined) placement.designId = designId;
    }
  }
  return project;
}

export function loadProject(id: string): Promise<Project | undefined> {
  return request<Project | undefined>('readonly', (store) => store.get(projectKey(id))).then(
    (project) => (project ? migrateProject(project) : undefined),
  );
}

export type ProjectMeta = Pick<Project, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

export async function listProjects(): Promise<ProjectMeta[]> {
  const keys = await request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  const ids = keys
    .filter((key): key is string => typeof key === 'string' && key.startsWith(PROJECT_PREFIX))
    .map((key) => key.slice(PROJECT_PREFIX.length));
  const metas = await Promise.all(ids.map((id) => loadProject(id)));
  return metas
    .filter((project): project is Project => Boolean(project))
    .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Remove a project together with every image it owns. */
export async function deleteProject(id: string): Promise<void> {
  const project = await loadProject(id);
  if (project) {
    const owned = [
      ...project.designs.map((d) => d.blobKey),
      ...project.mockups.map((m) => m.blobKey),
    ];
    await Promise.all(owned.map((key) => deleteBlob(key)));
  }
  await write((store) => store.delete(projectKey(id)));
}

/**
 * Round-trip probe. Surfaces a blocked, full, or unavailable IndexedDB as one
 * clear message instead of an opaque failure buried in whichever action ran
 * first.
 */
export async function verifyStorage(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const probe = '__probe__';
    await write((store) => store.put(Date.now(), probe));
    await write((store) => store.delete(probe));
    return { ok: true };
  } catch (error) {
    const name = (error as { name?: string }).name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'QuotaExceededError') return { ok: false, reason: 'Browser storage is full' };
    if (name === 'SecurityError') return { ok: false, reason: 'Private browsing blocks local storage' };
    if (/upgrade/i.test(message)) return { ok: false, reason: message };
    return { ok: false, reason: `Local storage unavailable (${name})` };
  }
}

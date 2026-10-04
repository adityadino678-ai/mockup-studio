/* Storage round-trip checks against a real IndexedDB implementation.
   Run: npm run test:storage */
import 'fake-indexeddb/auto';

import {
  blobKey,
  deleteProject,
  listProjects,
  loadBlob,
  loadProject,
  projectKey,
  saveBlob,
  saveProject,
  verifyStorage,
} from '../src/lib/db';
import type { Project } from '../src/types';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeProject(id: string, name: string, designs: number, mockups: number): Project {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 2,
    designs: Array.from({ length: designs }, (_, i) => ({
      id: `${id}-d${i}`,
      name: `design ${i}`,
      blobKey: `${id}-blob-d${i}`,
      width: 10,
      height: 10,
    })),
    mockups: Array.from({ length: mockups }, (_, i) => ({
      id: `${id}-m${i}`,
      name: `mockup ${i}`,
      blobKey: `${id}-blob-m${i}`,
      width: 100,
      height: 100,
      placements: {},
    })),
  };
}

async function main(): Promise<void> {
  console.log('Storage layer');

  // Reproduce exactly what the broken build left in the browser: a database
  // named 'mockup-studio' at version 1 holding only a 'projects' store.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('mockup-studio', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('projects');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(
        {
          id: 'stale',
          name: 'Old project',
          createdAt: 1,
          updatedAt: 1,
          designs: [],
          mockups: [],
        },
        'stale',
      );
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  console.log('  (legacy v1 database present — same state the user has)');

  const probe = await verifyStorage();
  check('verifyStorage passes over the legacy database', probe.ok, probe.ok ? '' : probe.reason);

  const stores = await new Promise<string[]>((resolve, reject) => {
    const req = indexedDB.open('mockup-studio');
    req.onsuccess = () => {
      const names = Array.from(req.result.objectStoreNames);
      req.result.close();
      resolve(names);
    };
    req.onerror = () => reject(req.error);
  });
  check('dead legacy store was removed', !stores.includes('projects'), JSON.stringify(stores));
  check('kv store now exists', stores.includes('kv'), JSON.stringify(stores));

  // The exact regression: a project write and a blob write in the same database.
  const project = makeProject('p1', 'Drop Shop', 3, 12);
  await saveProject(project);
  check('project write succeeds', (await loadProject('p1')) !== undefined);

  const blobKeys = [
    ...project.designs.map((d) => d.blobKey),
    ...project.mockups.map((m) => m.blobKey),
  ];
  let blobWritesOk = true;
  let blobError = '';
  try {
    await Promise.all(
      blobKeys.map((key, i) => saveBlob(key, new Blob([`image-${i}`], { type: 'image/png' }))),
    );
  } catch (error) {
    blobWritesOk = false;
    blobError = (error as Error).message;
  }
  check(
    'all 15 blob writes succeed alongside the project write',
    blobWritesOk,
    blobError,
  );

  const stored = await loadBlob(project.mockups[0].blobKey);
  const storedText = stored ? await stored.text() : null;
  check('blob reads back the right bytes', storedText === 'image-3', `got ${storedText}`);

  // Second round proves the store really exists, not just the first transaction.
  await saveProject({ ...project, name: 'Drop Shop v2', updatedAt: 99 });
  check('project rewrite succeeds', (await loadProject('p1'))?.name === 'Drop Shop v2');
  await saveBlob('extra', new Blob(['x']));
  check('later blob write succeeds', (await loadBlob('extra')) !== undefined);

  // Listing must ignore blob keys.
  await saveProject(makeProject('p2', 'Second', 0, 0));
  const metas = await listProjects();
  check('listProjects returns only projects', metas.length === 2, JSON.stringify(metas.map((m) => m.id)));
  check('listProjects sorts newest first', metas[0].id === 'p1', JSON.stringify(metas.map((m) => m.id)));
  check(
    'project count excludes blob keys',
    metas.every((m) => !m.id.startsWith('blob')),
  );

  // Deleting a project must not take other projects' images with it.
  await deleteProject('p1');
  check('deleted project is gone', (await loadProject('p1')) === undefined);
  check('other project survives', (await loadProject('p2')) !== undefined);
  check('owned blobs are cleaned up', (await loadBlob(project.mockups[0].blobKey)) === undefined);
  check('unrelated blob survives', (await loadBlob('extra')) !== undefined);

  // Key namespacing must not collide across kinds.
  check('blob keys are namespaced', blobKey('x') !== projectKey('x'));
  check('blob key shape', blobKey('x') === 'blob:x', blobKey('x'));
  check('project key shape', projectKey('x') === 'proj:x', projectKey('x'));

  // Full round trip with placements intact.
  const withPlacements = makeProject('p3', 'Placed', 1, 1);
  withPlacements.mockups[0].placements[withPlacements.designs[0].id] = {
    designId: withPlacements.designs[0].id,
    x: 640,
    y: 800,
    width: 512,
    height: 512,
    rotation: -12.5,
    opacity: 0.85,
    flipX: true,
    flipY: false,
    visible: true,
    blend: 'multiply',
  };
  await saveProject(withPlacements);
  const restored = (await loadProject('p3'))!;
  const placement = restored.mockups[0].placements[withPlacements.designs[0].id];
  check('placement survives a round trip', placement.x === 640 && placement.blend === 'multiply');
  check('designs survive a round trip', restored.designs.length === 1);

  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

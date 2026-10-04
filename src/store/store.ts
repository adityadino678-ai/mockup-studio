import { create } from 'zustand';
import type {
  BlendMode,
  Design,
  LoadedImage,
  Mockup,
  Placement,
  PrintifyConfig,
  Project,
  SafeFrame,
} from '../types';
import * as db from '../lib/db';
import { DEFAULT_PRINTIFY_CONFIG } from '../lib/db';
import { stripBackgrounds, removeBackground } from '../lib/bgRemove';
import { ingestFiles, type ImportFailure, type Ingested } from '../lib/files';
import { uid } from '../lib/id';
import { getImage, preloadImages } from '../lib/images';
import { DEFAULT_FRAME, frameBox, normalizeFrame } from '../lib/geometry';

export type ProjectMeta = { id: string; name: string; createdAt: number; updatedAt: number };

/** Per-design canvas zoom/pan, so tabs remember where you left them. */
export interface DesignView {
  scale: number;
  panX: number;
  panY: number;
  autoFit: boolean;
}

const HISTORY_LIMIT = 60;
const AUTO_BG_KEY = 'mockup-studio:auto-remove-bg';

/** Cutting the subject out of every design on import is the default. */
function readAutoRemoveBg(): boolean {
  try {
    return window.localStorage.getItem(AUTO_BG_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** What a design looks like when it is parked in the print area. */
export function framePlacement(
  frame: SafeFrame,
  mockup: Mockup,
): Pick<Placement, 'x' | 'y' | 'width' | 'height' | 'rotation'> {
  const b = frameBox(frame, mockup.width, mockup.height);
  return {
    x: b.center.x,
    y: b.center.y,
    width: b.width,
    height: b.height,
    rotation: b.rotation,
  };
}

export function defaultPlacement(
  design: Design,
  mockup: Mockup,
  frame: SafeFrame | null = null,
): Placement {
  const base = frame
    ? framePlacement(frame, mockup)
    : (() => {
        const width = mockup.width * 0.4;
        const height = width * (design.height / Math.max(design.width, 1));
        return { x: mockup.width / 2, y: mockup.height / 2, width, height, rotation: 0 };
      })();
  return {
    designId: design.id,
    ...base,
    opacity: 1,
    flipX: false,
    flipY: false,
    visible: true,
    blend: 'normal',
    fit: 'cover',
    linkedToFrame: Boolean(frame),
  };
}

/** The print area a mockup uses right now. */
export function mockupFrame(mockup: Mockup, project: Project): SafeFrame | null {
  return mockup.frameOverride ?? project.frame;
}

const GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'rotation'] as const;

/** Moving or resizing by hand detaches a design from the print area. */
function touchesGeometry(patch: Partial<Placement>): boolean {
  return GEOMETRY_KEYS.some((key) => patch[key] !== undefined);
}

/**
 * Re-derive every placement that is still glued to the print area, so moving the
 * box carries the designs with it and hand-placed ones stay put.
 */
function refitLinkedPlacements(p: Project): void {
  for (const mockup of p.mockups) {
    const frame = mockup.frameOverride ?? p.frame;
    if (!frame) continue;
    for (const placement of Object.values(mockup.placements)) {
      if (!placement.linkedToFrame) continue;
      const base = framePlacement(frame, mockup);
      placement.x = base.x;
      placement.y = base.y;
      placement.width = base.width;
      placement.height = base.height;
      placement.rotation = base.rotation;
    }
  }
}

function clone(p: Project): Project {
  return structuredClone(p);
}

function placementsEqual(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface StoreState {
  project: Project | null;
  projects: ProjectMeta[];
  images: Map<string, LoadedImage>;
  selectedMockupId: string | null;
  selectedDesignId: string | null;
  linked: boolean;
  aspectLock: boolean;
  snapEnabled: boolean;
  inspectorOpen: boolean;
  inspectorWidth: number;
  history: Project[];
  future: Project[];
  gestureBase: Project | null;
  ready: boolean;
  busy: string | null;
  toast: string | null;
  storageError: string | null;
  lastImport: { kind: 'design' | 'mockup'; added: number; failed: ImportFailure[] } | null;
  autoRemoveBg: boolean;
  /** When true the stage drags the print area instead of the design. */
  frameMode: boolean;
  designViews: Record<string, DesignView>;

  bootstrap: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (name: string) => void;
  removeProject: (id: string) => Promise<void>;
  duplicateProject: () => Promise<void>;

  addDesigns: (files: File[]) => Promise<void>;
  addMockups: (files: File[]) => Promise<void>;
  setAutoRemoveBg: (v: boolean) => void;
  removeDesignBackground: (id: string) => Promise<void>;
  removeDesign: (id: string) => void;
  removeMockup: (id: string) => void;
  renameMockup: (id: string, name: string) => void;
  moveMockup: (id: string, dir: -1 | 1) => void;
  clearAllMockups: () => void;

  selectMockup: (id: string | null) => void;
  selectDesign: (id: string | null) => void;
  setLinked: (v: boolean) => void;
  setAspectLock: (v: boolean) => void;
  setSnapEnabled: (v: boolean) => void;
  toggleInspector: () => void;
  setInspectorWidth: (w: number) => void;

  setFrameMode: (v: boolean) => void;
  patchFrame: (patch: Partial<SafeFrame>, opts?: { transient?: boolean }) => void;
  setFrameLocked: (v: boolean) => void;
  resetFrame: () => void;
  clearMockupFrameOverride: (mockupId: string) => void;
  refitDesign: (designId: string, mockupId?: string) => void;
  refitEveryDesign: () => void;
  saveDesignView: (designId: string, view: DesignView) => void;
  getDesignView: (designId: string) => DesignView | undefined;

  patchPrintify: (patch: Partial<PrintifyConfig>) => void;
  setColourSide: (blueprintId: number, colour: string, side: 'light' | 'dark' | 'unset') => void;
  toggleShortlistColour: (colour: string) => void;
  setShortlist: (colours: string[]) => void;
  setDesignLightInk: (designId: string, file: File | null) => Promise<void>;
  setDesignPositions: (designId: string, positions: string[]) => void;

  beginGesture: () => void;
  endGesture: () => void;
  update: (fn: (p: Project) => void) => void;
  patchPlacement: (
    designId: string,
    patch: Partial<Placement>,
    opts?: { transient?: boolean; mockupId?: string },
  ) => void;
  patchAll: (designId: string, patch: Partial<Placement>) => void;
  setBlendAll: (blend: BlendMode) => void;
  toggleVisible: (designId: string, mockupId?: string) => void;
  resetPlacement: (designId: string, mockupId?: string) => void;

  undo: () => void;
  redo: () => void;
  notify: (msg: string | null) => void;
  setBusy: (msg: string | null) => void;
  clearLastImport: () => void;
  ensureImages: () => void;
}

let saveTimer: number | undefined;
function scheduleSave(project: Project): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void db.saveProject(project).catch(() => {});
  }, 500);
}

function touch(p: Project): Project {
  p.updatedAt = Date.now();
  return p;
}

export const useStore = create<StoreState>((set, get) => {
  /** Mutates a *copy* of the project so React always sees a new reference. */
  const commit = (fn: (p: Project) => void, options?: { snapshot?: boolean }) => {
    const { project } = get();
    if (!project) return;
    const next = clone(project);
    fn(next);
    touch(next);
    if (options?.snapshot !== false) {
      set((s) => ({ project: next, history: [...s.history, project].slice(-HISTORY_LIMIT), future: [] }));
    } else {
      set({ project: next });
    }
    get().ensureImages();
    scheduleSave(next);
  };

  const ingest = async (files: File[], kind: 'design' | 'mockup'): Promise<void> => {
    const { project } = get();
    if (!project || files.length === 0) return;
    set({ busy: `Importing ${files.length} ${kind}${files.length > 1 ? 's' : ''}…` });
    try {
      const { added, failed } = await ingestFiles(files);

      // Cut the subject out of every design before anything is written, so the
      // stored blob is already the transparent one.
      const items =
        kind === 'design' && added.length > 0 && get().autoRemoveBg
          ? await stripBackgrounds(added, {
              onProgress: ({ label }) => set({ busy: label }),
            })
          : { items: added, skipped: [] };

      if (items.skipped.length > 0) {
        failed.push(...items.skipped.map((s) => ({ name: s.name, reason: `background kept — ${s.reason}` })));
      }

      if (added.length > 0) {
        await db.saveProject(project);
        await Promise.all(items.items.map((i) => db.saveBlob(i.blobKey, i.blob)));
        commit((p) => {
          for (const item of items.items) applyIngest(p, item, kind);
        });
      }
      set({ lastImport: { kind, added: added.length, failed } });
      const plural = added.length === 1 ? '' : 's';
      if (added.length > 0) {
        get().notify(
          failed.length
            ? `${added.length} ${kind}${plural} added · ${failed.length} skipped`
            : `${added.length} ${kind}${plural} added`,
        );
      } else {
        get().notify(`Nothing imported — ${failed.length} file${failed.length === 1 ? '' : 's'} skipped`);
      }
    } catch (err) {
      set({ lastImport: { kind, added: 0, failed: [{ name: 'batch', reason: (err as Error).message }] } });
      get().notify(`Import failed: ${(err as Error).message}`);
    } finally {
      set({ busy: null });
    }
  };

  return {
    project: null,
    projects: [],
    images: new Map(),
    selectedMockupId: null,
    selectedDesignId: null,
    linked: false,
    aspectLock: true,
    snapEnabled: true,
    inspectorOpen: true,
    inspectorWidth: 304,
    history: [],
    future: [],
    gestureBase: null,
    ready: false,
    busy: null,
    toast: null,
    storageError: null,
    lastImport: null,
    autoRemoveBg: readAutoRemoveBg(),
    frameMode: false,
    designViews: {},

    bootstrap: async () => {
      const health = await db.verifyStorage();
      if (!health.ok) {
        set({ ready: true, storageError: health.reason });
        return;
      }
      const metas = await db.listProjects();
      set({ projects: metas });
      if (metas.length > 0) await get().openProject(metas[0].id);
      else await get().createProject('My mockups');
      set({ ready: true });
    },

    refreshProjects: async () => {
      const { project } = get();
      set({ projects: await db.listProjects() });
      if (project) scheduleSave(project);
    },

    createProject: async (name = 'Untitled project') => {
      const project: Project = {
        id: uid('proj'),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        designs: [],
        mockups: [],
        frame: { ...DEFAULT_FRAME },
        frameLocked: true,
        printify: { ...DEFAULT_PRINTIFY_CONFIG },
      };
      await db.saveProject(project);
      set({
        project,
        projects: await db.listProjects(),
        selectedMockupId: null,
        selectedDesignId: null,
        history: [],
        future: [],
        images: new Map(),
        designViews: {},
      });
    },

    openProject: async (id) => {
      const project = await db.loadProject(id);
      if (!project) return;
      set({
        project,
        selectedMockupId: project.mockups[0]?.id ?? null,
        selectedDesignId: project.designs[0]?.id ?? null,
        history: [],
        future: [],
        images: new Map(),
        designViews: {},
      });
      get().ensureImages();
    },

    renameProject: (name) => {
      commit((p) => {
        p.name = name.trim() || 'Untitled project';
      });
      void get().refreshProjects();
    },

    removeProject: async (id) => {
      await db.deleteProject(id);
      const metas = await db.listProjects();
      set({ projects: metas });
      if (get().project?.id === id) {
        if (metas.length > 0) await get().openProject(metas[0].id);
        else await get().createProject('My mockups');
      }
    },

    duplicateProject: async () => {
      const src = get().project;
      if (!src) return;
      const copy: Project = structuredClone(src);
      copy.id = uid('proj');
      copy.name = `${src.name} copy`;
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();

      const idMap = new Map<string, string>();
      copy.designs = await Promise.all(
        src.designs.map(async (d) => {
          const nextId = uid('d');
          const nextKey = uid('blob');
          idMap.set(d.id, nextId);
          const blob = await db.loadBlob(d.blobKey);
          if (blob) await db.saveBlob(nextKey, blob);
          return { ...d, id: nextId, blobKey: nextKey };
        }),
      );

      copy.mockups = await Promise.all(
        src.mockups.map(async (m) => {
          const nextKey = uid('blob');
          const blob = await db.loadBlob(m.blobKey);
          if (blob) await db.saveBlob(nextKey, blob);
          const placements: Record<string, Placement> = {};
          for (const [oldId, p] of Object.entries(m.placements)) {
            const newId = idMap.get(oldId);
            if (newId) placements[newId] = { ...p, designId: newId };
          }
          return { ...m, id: uid('m'), blobKey: nextKey, placements };
        }),
      );

      await db.saveProject(copy);
      set({ projects: await db.listProjects() });
      await get().openProject(copy.id);
      get().notify('Project duplicated');
    },

    addDesigns: (files) => ingest(files, 'design'),
    addMockups: (files) => ingest(files, 'mockup'),

    setAutoRemoveBg: (v) => {
      try {
        window.localStorage.setItem(AUTO_BG_KEY, v ? 'on' : 'off');
      } catch {
        /* private mode: the preference just will not stick */
      }
      set({ autoRemoveBg: v });
    },

    removeDesignBackground: async (id) => {
      const design = get().project?.designs.find((d) => d.id === id);
      if (!design) return;
      set({ busy: `Removing the background of ${design.name}…` });
      try {
        const original = await db.loadBlob(design.blobKey);
        if (!original) throw new Error('the original image is missing');
        const blob = await removeBackground(original, {
          onProgress: ({ label }) => set({ busy: `${design.name} · ${label}` }),
        });
        if (blob === original) {
          get().notify('That design already has a transparent background');
          return;
        }
        const key = uid('blob');
        await db.saveBlob(key, blob);
        // The old key stays around so undo can restore it, which means the
        // decoded image for this design has to be dropped and reloaded.
        set((s) => {
          const next = new Map(s.images);
          next.delete(id);
          return { images: next };
        });
        commit((p) => {
          const target = p.designs.find((d) => d.id === id);
          if (target) {
            target.blobKey = key;
            target.bgRemoved = true;
          }
        });
        get().notify(`Background removed from ${design.name}`);
      } catch (err) {
        get().notify(`Could not remove that background: ${(err as Error).message}`);
      } finally {
        set({ busy: null });
      }
    },

    removeDesign: (id) => {
      commit((p) => {
        p.designs = p.designs.filter((d) => d.id !== id);
        for (const m of p.mockups) delete m.placements[id];
      });
      if (get().selectedDesignId === id) set({ selectedDesignId: get().project?.designs[0]?.id ?? null });
    },

    removeMockup: (id) => {
      const remaining = get().project?.mockups.filter((m) => m.id !== id) ?? [];
      commit((p) => {
        p.mockups = p.mockups.filter((m) => m.id !== id);
      });
      const ids = remaining.map((m) => m.id);
      if (get().selectedMockupId && !ids.includes(get().selectedMockupId!)) {
        set({ selectedMockupId: ids[0] ?? null });
      }
    },

    renameMockup: (id, name) => {
      commit((p) => {
        const m = p.mockups.find((x) => x.id === id);
        if (m) m.name = name.trim() || m.name;
      });
    },

    moveMockup: (id, dir) => {
      commit((p) => {
        const i = p.mockups.findIndex((m) => m.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= p.mockups.length) return;
        const [item] = p.mockups.splice(i, 1);
        p.mockups.splice(j, 0, item);
      });
    },

    clearAllMockups: () => {
      commit((p) => {
        for (const m of p.mockups) m.placements = {};
      });
    },

    selectMockup: (id) => set({ selectedMockupId: id }),
    selectDesign: (id) => set({ selectedDesignId: id }),
    setLinked: (v) => set({ linked: v }),
    setAspectLock: (v) => set({ aspectLock: v }),
    setSnapEnabled: (v) => set({ snapEnabled: v }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
    setInspectorWidth: (w) =>
      set({ inspectorWidth: Math.max(240, Math.min(560, Math.round(w))) }),

    beginGesture: () => {
      const { project } = get();
      if (project && !get().gestureBase) set({ gestureBase: clone(project) });
    },

    endGesture: () => {
      const { gestureBase, project } = get();
      if (!gestureBase || !project) return set({ gestureBase: null });
      if (!placementsEqual(gestureBase, project)) {
        set((s) => ({
          history: [...s.history, gestureBase].slice(-HISTORY_LIMIT),
          future: [],
          gestureBase: null,
        }));
      } else {
        set({ gestureBase: null });
      }
    },

    update: (fn) => commit(fn),

    setFrameMode: (v) => set({ frameMode: v }),

    patchFrame: (patch, opts) => {
      commit(
        (p) => {
          const locked = p.frameLocked;
          const mockup = locked ? null : p.mockups.find((m) => m.id === get().selectedMockupId);
          const current = mockup?.frameOverride ?? p.frame ?? DEFAULT_FRAME;
          const next = normalizeFrame(
            { ...current, rotation: current.rotation ?? 0, ...patch },
            mockup ? { width: mockup.width, height: mockup.height } : undefined,
          );

          if (locked) {
            // One shared print area, so any per-mockup overrides are now stale.
            p.frame = next;
            for (const m of p.mockups) m.frameOverride = null;
          } else if (mockup) {
            mockup.frameOverride = next;
          } else {
            p.frame = next;
          }
          refitLinkedPlacements(p);
        },
        { snapshot: !opts?.transient },
      );
    },

    setFrameLocked: (v) => {
      commit((p) => {
        p.frameLocked = v;
        // Re-linking throws away the individual tweaks so every mockup agrees again,
        // which means the designs have to snap back onto the shared area too.
        if (v) for (const m of p.mockups) m.frameOverride = null;
        refitLinkedPlacements(p);
      });
    },

    resetFrame: () => {
      commit((p) => {
        p.frame = { ...DEFAULT_FRAME };
        for (const m of p.mockups) m.frameOverride = null;
        refitLinkedPlacements(p);
      });
      get().notify('Print area reset');
    },

    clearMockupFrameOverride: (mockupId) => {
      commit((p) => {
        const mockup = p.mockups.find((m) => m.id === mockupId);
        if (!mockup) return;
        mockup.frameOverride = null;
        refitLinkedPlacements(p);
      });
    },

    refitDesign: (designId, mockupId) => {
      commit((p) => {
        const ids = mockupId ? [mockupId] : p.mockups.map((m) => m.id);
        for (const id of ids) {
          const mockup = p.mockups.find((m) => m.id === id);
          if (!mockup) continue;
          const frame = mockup.frameOverride ?? p.frame;
          if (!frame) continue;
          const existing = mockup.placements[designId];
          const base = framePlacement(frame, mockup);
          mockup.placements[designId] = {
            ...(existing ?? defaultPlacement(p.designs.find((d) => d.id === designId)!, mockup, frame)),
            ...base,
            designId,
            linkedToFrame: true,
          };
        }
      });
    },

    refitEveryDesign: () => {
      commit((p) => {
        for (const mockup of p.mockups) {
          const frame = mockup.frameOverride ?? p.frame;
          if (!frame) continue;
          for (const design of p.designs) {
            const existing = mockup.placements[design.id];
            mockup.placements[design.id] = {
              ...(existing ?? defaultPlacement(design, mockup, frame)),
              ...framePlacement(frame, mockup),
              designId: design.id,
              linkedToFrame: true,
            };
          }
        }
      });
      get().notify('Every design re-fitted to the print area');
    },

    saveDesignView: (designId, view) =>
      set((s) => ({ designViews: { ...s.designViews, [designId]: view } })),

    getDesignView: (designId) => get().designViews[designId],

    patchPrintify: (patch) => {
      commit((p) => {
        p.printify = { ...p.printify, ...patch };
      });
    },

    setColourSide: (blueprintId, colour, side) => {
      commit((p) => {
        const key = String(blueprintId);
        p.printify.colourSides = {
          ...p.printify.colourSides,
          [key]: { ...(p.printify.colourSides[key] ?? {}), [colour]: side },
        };
      });
    },

    toggleShortlistColour: (colour) => {
      commit((p) => {
        const has = p.printify.shortlist.includes(colour);
        p.printify.shortlist = has
          ? p.printify.shortlist.filter((c) => c !== colour)
          : [...p.printify.shortlist, colour];
      });
    },

    setShortlist: (colours) => {
      commit((p) => {
        p.printify.shortlist = colours;
      });
    },

    setDesignLightInk: async (designId, file) => {
      let ink: { blobKey: string; name: string } | undefined;
      if (file) {
        const key = uid('blob');
        await db.saveBlob(key, file);
        ink = { blobKey: key, name: file.name };
      }
      // The decoded image cache is keyed by design id, and the light-ink file is
      // never rendered on the canvas, so nothing needs evicting here.
      commit((p) => {
        const design = p.designs.find((d) => d.id === designId);
        if (design) design.lightInk = ink;
      });
    },

    setDesignPositions: (designId, positions) => {
      commit((p) => {
        const design = p.designs.find((d) => d.id === designId);
        if (design) design.printPositions = positions;
      });
    },

    patchPlacement: (designId, patch, opts) => {
      const { linked, selectedMockupId } = get();
      const targets =
        opts?.mockupId !== undefined
          ? [opts.mockupId]
          : linked
            ? (get().project?.mockups.map((m) => m.id) ?? [])
            : [selectedMockupId].filter(Boolean) as string[];
      const frees = touchesGeometry(patch);
      commit(
        (p) => {
          for (const mockupId of targets) {
            const mockup = p.mockups.find((m) => m.id === mockupId);
            if (!mockup) continue;
            const base =
              mockup.placements[designId] ??
              (() => {
                const design = p.designs.find((d) => d.id === designId);
                return design ? defaultPlacement(design, mockup, p.frame) : null;
              })();
            if (!base) continue;
            mockup.placements[designId] = {
              ...base,
              ...patch,
              designId,
              // Moving or resizing by hand takes the design off the print area.
              linkedToFrame: frees ? false : (patch.linkedToFrame ?? base.linkedToFrame),
            };
          }
        },
        { snapshot: !opts?.transient },
      );
    },

    patchAll: (designId, patch) => {
      const frees = touchesGeometry(patch);
      commit((p) => {
        for (const mockup of p.mockups) {
          const design = p.designs.find((d) => d.id === designId);
          if (!design) continue;
          const base = mockup.placements[designId] ?? defaultPlacement(design, mockup, p.frame);
          mockup.placements[designId] = {
            ...base,
            ...patch,
            designId,
            linkedToFrame: frees ? false : (patch.linkedToFrame ?? base.linkedToFrame),
          };
        }
      });
    },

    setBlendAll: (blend) => {
      const designId = get().selectedDesignId;
      if (!designId) return;
      get().patchAll(designId, { blend });
    },

    toggleVisible: (designId, mockupId) => {
      const { linked, selectedMockupId, project } = get();
      if (!project) return;
      const scopeId =
        mockupId ?? (linked ? undefined : (selectedMockupId ?? project.mockups[0]?.id));
      if (!scopeId) return;
      const mockup = project.mockups.find((m) => m.id === scopeId);
      if (!mockup) return;
      const current = mockup.placements[designId]?.visible ?? false;
      get().patchPlacement(designId, { visible: !current }, { mockupId: scopeId });
    },

    resetPlacement: (designId, mockupId) => {
      const { linked, selectedMockupId, project } = get();
      if (!project) return;
      const design = project.designs.find((d) => d.id === designId);
      if (!design) return;
      const ids =
        mockupId !== undefined
          ? [mockupId]
          : linked
            ? project.mockups.map((m) => m.id)
            : [selectedMockupId].filter(Boolean) as string[];
      commit((p) => {
        for (const id of ids) {
          const mockup = p.mockups.find((m) => m.id === id);
          if (!mockup) continue;
          const previous = mockup.placements[designId];
          mockup.placements[designId] = defaultPlacement(
            design,
            mockup,
            mockup.frameOverride ?? p.frame,
          );
          // Reset should not silently throw away opacity/blend choices.
          if (previous) {
            const fresh = mockup.placements[designId];
            fresh.opacity = previous.opacity;
            fresh.blend = previous.blend;
            fresh.visible = previous.visible;
            fresh.fit = previous.fit;
          }
        }
      });
    },

    undo: () => {
      const { history, project, future } = get();
      if (history.length === 0 || !project) return;
      const prev = history[history.length - 1];
      set({ project: prev, history: history.slice(0, -1), future: [project, ...future].slice(0, HISTORY_LIMIT) });
      reconcileSelection(get().project);
      get().ensureImages();
      scheduleSave(prev);
    },

    redo: () => {
      const { history, project, future } = get();
      if (future.length === 0 || !project) return;
      const next = future[0];
      set({ project: next, history: [...history, project].slice(-HISTORY_LIMIT), future: future.slice(1) });
      reconcileSelection(get().project);
      get().ensureImages();
      scheduleSave(next);
    },

    notify: (msg) => set({ toast: msg }),
    setBusy: (msg) => set({ busy: msg }),
    clearLastImport: () => set({ lastImport: null }),

    ensureImages: () => {
      const { project, images } = get();
      if (!project) return;
      const next = new Map(images);
      let added = false;
      for (const d of project.designs) {
        if (!next.has(d.id)) {
          added = true;
          preloadImages([d.blobKey]);
          void getImage(d.blobKey)
            .then((loaded) => {
              const cur = new Map(get().images);
              cur.set(d.id, loaded);
              set({ images: cur });
            })
            .catch(() => {});
        }
      }
      for (const m of project.mockups) {
        if (!next.has(m.id)) {
          added = true;
          preloadImages([m.blobKey]);
          void getImage(m.blobKey)
            .then((loaded) => {
              const cur = new Map(get().images);
              cur.set(m.id, loaded);
              set({ images: cur });
            })
            .catch(() => {});
        }
      }
      void added;
    },
  };
});

function reconcileSelection(project: Project | null): void {
  if (!project) return;
  const s = useStore.getState();
  const nextMockup =
    s.selectedMockupId && project.mockups.some((m) => m.id === s.selectedMockupId)
      ? s.selectedMockupId
      : (project.mockups[0]?.id ?? null);
  const nextDesign =
    s.selectedDesignId && project.designs.some((d) => d.id === s.selectedDesignId)
      ? s.selectedDesignId
      : (project.designs[0]?.id ?? null);
  useStore.setState({ selectedMockupId: nextMockup, selectedDesignId: nextDesign });
}

function applyIngest(project: Project, item: Ingested, kind: 'design' | 'mockup'): void {
  if (kind === 'design') {
    const design: Design = {
      id: uid('d'),
      name: item.name,
      blobKey: item.blobKey,
      width: item.width,
      height: item.height,
      bgRemoved: item.bgRemoved,
    };
    project.designs.push(design);
    for (const mockup of project.mockups) {
      mockup.placements[design.id] = defaultPlacement(design, mockup, project.frame);
    }
    useStore.setState({ selectedDesignId: design.id });
  } else {
    const mockup: Mockup = {
      id: uid('m'),
      name: item.name,
      blobKey: item.blobKey,
      width: item.width,
      height: item.height,
      placements: {},
      frameOverride: null,
    };
    for (const design of project.designs) {
      mockup.placements[design.id] = defaultPlacement(design, mockup, project.frame);
    }
    project.mockups.push(mockup);
    if (!useStore.getState().selectedMockupId) {
      useStore.setState({ selectedMockupId: mockup.id });
    }
  }
}

import JSZip from 'jszip';
import type { Design, ExportSettings, LoadedImage, Mockup, Project } from '../types';
import { getImage } from './images';
import { makeCanvas, renderMockup } from './render';

export const MAX_CANVAS_EDGE = 16384;

export interface ExportProgress {
  done: number;
  total: number;
  current: string;
}

export interface ExportResult {
  blob: Blob;
  count: number;
  clamped: string[];
}

function sanitize(part: string): string {
  return (
    part
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim() || 'mockup'
  );
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** How many files an export will produce, so the dialog can show it up front. */
export function countExportPairs(
  project: Project,
  mockupFilter?: Set<string>,
  designFilter?: Set<string>,
): { designs: Design[]; mockups: Mockup[]; count: number } {
  const designs = project.designs.filter((d) => !designFilter || designFilter.has(d.id));
  const mockups = project.mockups.filter((m) => !mockupFilter || mockupFilter.has(m.id));
  const count = designs.reduce(
    (sum, d) => sum + mockups.filter((m) => m.placements[d.id]?.visible).length,
    0,
  );
  return { designs, mockups, count };
}

export function buildFileName(
  template: string,
  vars: { project: string; mockup: string; index: number; total: number; design: string; w: number; h: number },
): string {
  const now = new Date();
  const map: Record<string, string> = {
    project: vars.project,
    mockup: vars.mockup,
    index: String(vars.index),
    total: String(vars.total),
    design: vars.design,
    w: String(vars.w),
    h: String(vars.h),
    date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    time: `${two(now.getHours())}${two(now.getMinutes())}`,
  };
  const withIndex = template.replace(/\{(project|mockup|index|total|design|w|h|date|time)\}/g, (_, key: string) =>
    map[key] ?? '',
  );
  return withIndex
    .split('{')
    .filter((chunk, i) => {
      void chunk;
      return i === 0 || !chunk.includes('}');
    })
    .join('-')
    .replace(/\.(png|jpe?g)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[\\/]/)
    .map(sanitize)
    .filter(Boolean)
    .join('_') || 'mockup';
}

async function canvasToBlob(canvas: HTMLCanvasElement, settings: ExportSettings): Promise<Blob> {
  const type = settings.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, settings.quality),
  );
  if (!blob) throw new Error('Canvas encoding failed');
  return blob;
}

/**
 * Renders one PNG per design per mockup, grouped into a folder per design:
 *
 *   Project/design-1/shirt-front.png
 *   Project/design-1/shirt-back.png
 *   Project/design-2/mug-front.png
 *
 * Each file carries exactly one design, so what you see in a design tab is what
 * lands in that design's folder. Hidden placements are skipped.
 */
export async function exportProject(
  project: Project,
  settings: ExportSettings,
  onProgress?: (p: ExportProgress) => void,
  mockupFilter?: Set<string>,
  designFilter?: Set<string>,
): Promise<ExportResult> {
  const designImages = new Map<string, LoadedImage>();
  const { designs: targetDesigns, mockups: targetMockups } = countExportPairs(
    project,
    mockupFilter,
    designFilter,
  );

  for (const design of targetDesigns) {
    try {
      designImages.set(design.id, await getImage(design.blobKey));
    } catch {
      /* design image unavailable; skip its folder */
    }
  }

  const zip = new JSZip();
  const root = zip.folder(project.name) ?? zip;
  const clamped: string[] = [];

  const pairs: { design: Design; mockup: Mockup }[] = [];
  for (const design of targetDesigns) {
    if (!designImages.has(design.id)) continue;
    for (const mockup of targetMockups) {
      if (mockup.placements[design.id]?.visible) pairs.push({ design, mockup });
    }
  }

  const usedByFolder = new Map<string, Set<string>>();

  for (let i = 0; i < pairs.length; i++) {
    const { design, mockup } = pairs[i];
    onProgress?.({ done: i, total: pairs.length, current: `${design.name} · ${mockup.name}` });

    const mockupImage = await getImage(mockup.blobKey);
    let scale = settings.scale;
    if (mockup.width * scale > MAX_CANVAS_EDGE || mockup.height * scale > MAX_CANVAS_EDGE) {
      scale = Math.min(MAX_CANVAS_EDGE / mockup.width, MAX_CANVAS_EDGE / mockup.height);
      clamped.push(`${design.name} · ${mockup.name}`);
    }

    const transparent = settings.format === 'png' && settings.transparent;
    const canvas = makeCanvas(mockup.width * scale, mockup.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');

    renderMockup(ctx, {
      mockup,
      mockupImage,
      designs: designImages,
      scale,
      background: transparent ? null : '#ffffff',
      showSelection: false,
      onlyDesignId: design.id,
    });

    const folderName = sanitize(design.name) || 'design';
    const folder = root.folder(folderName) ?? root;
    const base = buildFileName(settings.naming, {
      project: project.name,
      mockup: mockup.name,
      index: i + 1,
      total: pairs.length,
      design: design.name,
      w: Math.round(mockup.width * scale),
      h: Math.round(mockup.height * scale),
    });

    const used = usedByFolder.get(folderName) ?? new Set<string>();
    usedByFolder.set(folderName, used);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${n++}`;
    }
    used.add(name.toLowerCase());

    folder.file(
      `${name}.${settings.format === 'png' ? 'png' : 'jpg'}`,
      await canvasToBlob(canvas, settings),
    );

    canvas.width = 0;
    canvas.height = 0;
  }

  onProgress?.({ done: pairs.length, total: pairs.length, current: 'Compressing' });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
    onProgress?.({
      done: meta.percent ? pairs.length - 1 : pairs.length,
      total: pairs.length,
      current: `Compressing ${Math.round(meta.percent)}%`,
    });
  });

  return { blob, count: pairs.length, clamped };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function mockupHasVisibleDesign(mockup: Mockup): boolean {
  return Object.values(mockup.placements).some((p) => p.visible);
}

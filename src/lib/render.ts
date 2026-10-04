import type { LoadedImage, Mockup, Placement, SafeFrame } from '../types';
import {
  CORNERS,
  CORNER_SIGN,
  type Guide,
  type Vec,
  frameCorners,
  frameRotateHandle,
  placementCorners,
  rotateHandlePoint,
} from './geometry';

export const ACCENT = '#5b8cff';
export const ACCENT_SOFT = 'rgba(91, 140, 255, 0.16)';
export const GUIDE_COLOR = '#ff3d8b';
export const FRAME_COLOR = '#ffb020';

export interface RenderOptions {
  mockup: Mockup;
  /** designId -> decoded design image */
  designs: Map<string, LoadedImage>;
  mockupImage: LoadedImage;
  /** output pixels per mockup pixel */
  scale: number;
  /** CSS colour painted under the mockup; null = keep transparency */
  background: string | null;
  selectedDesignId?: string | null;
  /** When set, every other design is left off — one design per mockup. */
  onlyDesignId?: string | null;
  guides?: Guide[];
  showSelection?: boolean;
  /** Drawn as a dashed print area; pass null to hide it. */
  frame?: SafeFrame | null;
  frameActive?: boolean;
  padding?: number;
}

export function renderMockup(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const { mockup, mockupImage, designs, scale, background } = opts;
  const padding = opts.padding ?? 0;

  ctx.save();
  ctx.clearRect(
    -padding,
    -padding,
    mockup.width * scale + padding * 2,
    mockup.height * scale + padding * 2,
  );
  ctx.translate(padding, padding);
  ctx.scale(scale, scale);

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, mockup.width, mockup.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mockupImage.image, 0, 0, mockup.width, mockup.height);

  const order = Object.keys(mockup.placements);
  for (const designId of order) {
    if (opts.onlyDesignId && designId !== opts.onlyDesignId) continue;
    const placement = mockup.placements[designId];
    if (!placement.visible) continue;
    const image = designs.get(designId);
    if (!image) continue;
    drawPlacement(ctx, placement, image);
  }

  ctx.restore();

  ctx.save();
  ctx.translate(padding, padding);
  ctx.scale(scale, scale);
  if (opts.frame) {
    drawFrame(ctx, opts.frame, mockup, scale, Boolean(opts.frameActive));
  }
  if (opts.showSelection && opts.selectedDesignId) {
    const placement = mockup.placements[opts.selectedDesignId];
    if (placement && placement.visible) {
      drawSelection(ctx, placement, scale);
    }
  }
  if (opts.guides?.length) drawGuides(ctx, opts.guides, mockup);
  ctx.restore();
}

/** Source rect + destination rect for `object-fit` inside a placement box. */
function fitRects(
  fit: Placement['fit'],
  natural: { width: number; height: number },
  box: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const nw = Math.max(1, natural.width);
  const nh = Math.max(1, natural.height);
  const bw = Math.max(1, box.width);
  const bh = Math.max(1, box.height);

  if (fit === 'stretch') {
    return { sx: 0, sy: 0, sw: nw, sh: nh, dx: -bw / 2, dy: -bh / 2, dw: bw, dh: bh };
  }

  const designAspect = nw / nh;
  const boxAspect = bw / bh;

  if (fit === 'contain') {
    // Whole design visible, centred, with empty space where the ratios differ.
    const dw = designAspect > boxAspect ? bw : bh * designAspect;
    const dh = designAspect > boxAspect ? bw / designAspect : bh;
    return { sx: 0, sy: 0, sw: nw, sh: nh, dx: -dw / 2, dy: -dh / 2, dw, dh };
  }

  // cover: fill the box and crop the overflow symmetrically.
  if (designAspect > boxAspect) {
    const sh = nh;
    const sw = nh * boxAspect;
    return { sx: (nw - sw) / 2, sy: 0, sw, sh, dx: -bw / 2, dy: -bh / 2, dw: bw, dh: bh };
  }
  const sw = nw;
  const sh = nw / boxAspect;
  return { sx: 0, sy: (nh - sh) / 2, sw, sh, dx: -bw / 2, dy: -bh / 2, dw: bw, dh: bh };
}

export function drawPlacement(
  ctx: CanvasRenderingContext2D,
  placement: Placement,
  image: LoadedImage,
): void {
  const { sx, sy, sw, sh, dx, dy, dw, dh } = fitRects(placement.fit, image, placement);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, placement.opacity));
  ctx.globalCompositeOperation = placement.blend as GlobalCompositeOperation;
  ctx.translate(placement.x, placement.y);
  if (placement.rotation) ctx.rotate((placement.rotation * Math.PI) / 180);
  ctx.scale(placement.flipX ? -1 : 1, placement.flipY ? -1 : 1);
  ctx.drawImage(image.image, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

/** The dashed, draggable print area. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: SafeFrame,
  mockup: { width: number; height: number },
  scale: number,
  active: boolean,
): void {
  const corners = frameCorners(frame, mockup.width, mockup.height);
  const lw = 1.5 / scale;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();

  ctx.fillStyle = active ? 'rgba(255, 176, 32, 0.10)' : 'rgba(255, 176, 32, 0.05)';
  ctx.fill();
  ctx.setLineDash(active ? [7 / scale, 5 / scale] : [4 / scale, 4 / scale]);
  ctx.lineWidth = lw;
  ctx.strokeStyle = FRAME_COLOR;
  ctx.stroke();
  ctx.setLineDash([]);

  if (active) {
    const size = 9 / scale;
    for (const p of corners) {
      ctx.beginPath();
      ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = FRAME_COLOR;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // Rotate grip on a stalk off the nearest free edge, so it follows the box as
    // it turns and never ends up off the canvas.
    const { anchor, grip } = frameRotateHandle(frame, mockup.width, mockup.height, scale);
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(grip.x, grip.y);
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(grip.x, grip.y, 5.5 / scale, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = lw;
    ctx.stroke();

    // Too small to read on a thumbnail, so the label only shows while editing.
    const deg = Math.round(frame.rotation ?? 0);
    ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = FRAME_COLOR;
    ctx.fillText(
      deg ? `PRINT AREA · ${deg}°` : 'PRINT AREA',
      anchor.x,
      anchor.y - 5 / scale,
    );
  }
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, placement: Placement, scale: number): void {
  const center = { x: placement.x, y: placement.y };
  const corners = placementCorners(center, placement.width, placement.height, placement.rotation);
  const lw = 1.5 / scale;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  strokePoly(ctx, corners, true);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = lw * 0.66;
  strokePoly(ctx, corners, false);

  const size = 9 / scale;
  const rot = rotateHandlePoint(center, placement.height, placement.rotation, 26 / scale);
  const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  ctx.beginPath();
  ctx.moveTo(topMid.x, topMid.y);
  ctx.lineTo(rot.x, rot.y);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = lw;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(rot.x, rot.y, 5.5 / scale, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = lw;
  ctx.stroke();

  for (let i = 0; i < CORNERS.length; i++) {
    const p = corners[i];
    const c = corners[(i + 1) % 4];
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(c.x, c.y);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  for (const id of CORNERS) {
    const idx = CORNERS.indexOf(id);
    const p = corners[idx];
    const s = CORNER_SIGN[id];
    void s;
    ctx.beginPath();
    ctx.rect(p.x - size / 2, p.y - size / 2, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  ctx.restore();
}

function strokePoly(ctx: CanvasRenderingContext2D, pts: Vec[], outset: boolean): void {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.stroke();
  if (outset) return;
}

function drawGuides(
  ctx: CanvasRenderingContext2D,
  guides: Guide[],
  mockup: { width: number; height: number },
): void {
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  for (const g of guides) {
    const at = g.space === 'norm' ? g.at * (g.axis === 'x' ? mockup.width : mockup.height) : g.at;
    const from = g.space === 'norm' ? g.from * (g.axis === 'x' ? mockup.width : mockup.height) : g.from;
    const to = g.space === 'norm' ? g.to * (g.axis === 'x' ? mockup.width : mockup.height) : g.to;
    ctx.beginPath();
    if (g.axis === 'x') {
      ctx.moveTo(at + 0.5, from);
      ctx.lineTo(at + 0.5, to);
    } else {
      ctx.moveTo(from, at + 0.5);
      ctx.lineTo(to, at + 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

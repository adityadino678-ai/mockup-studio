import type { SafeFrame } from '../types';

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CornerId = 'nw' | 'ne' | 'se' | 'sw';
export type HandleId = CornerId | 'rot';

export const CORNERS: CornerId[] = ['nw', 'ne', 'se', 'sw'];
export const CORNER_SIGN: Record<CornerId, Vec> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
};

export const ROTATE_OFFSET = 28;

export function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

export function rotateVec(v: Vec, deg: number): Vec {
  const a = deg2rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

export function toLocal(center: Vec, p: Vec, rotation: number): Vec {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const a = deg2rad(-rotation);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** Corner points of a placement, in mockup pixel space. */
export function placementCorners(
  center: Vec,
  width: number,
  height: number,
  rotation: number,
): Vec[] {
  const hw = width / 2;
  const hh = height / 2;
  return CORNERS.map((id) => {
    const s = CORNER_SIGN[id];
    const p = rotateVec({ x: s.x * hw, y: s.y * hh }, rotation);
    return { x: center.x + p.x, y: center.y + p.y };
  });
}

export function rotateHandlePoint(
  center: Vec,
  height: number,
  rotation: number,
  offset: number,
): Vec {
  const top = rotateVec({ x: 0, y: -height / 2 }, rotation);
  const dir = rotateVec({ x: 0, y: -1 }, rotation);
  return {
    x: center.x + top.x + dir.x * offset,
    y: center.y + top.y + dir.y * offset,
  };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/* ---------- print area (safe frame) ---------- */

/** First-run print area: a 10% inset on every side. */
export const DEFAULT_FRAME: SafeFrame = { x: 0.1, y: 0.1, w: 0.8, h: 0.8, rotation: 0 };

export const MIN_FRAME = 0.02;

/** Normalised frame -> its unrotated rect in mockup pixel space. */
export function frameRect(frame: SafeFrame, width: number, height: number): Rect {
  return {
    x: frame.x * width,
    y: frame.y * height,
    w: Math.max(1, frame.w * width),
    h: Math.max(1, frame.h * height),
  };
}

/** The frame as a rotatable box in mockup pixel space. */
export function frameBox(
  frame: SafeFrame,
  width: number,
  height: number,
): { center: Vec; width: number; height: number; rotation: number } {
  const r = frameRect(frame, width, height);
  return {
    center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
    width: r.w,
    height: r.h,
    rotation: frame.rotation ?? 0,
  };
}

/** The frame's four corners, in mockup pixel space, honouring its rotation. */
export function frameCorners(frame: SafeFrame, width: number, height: number): Vec[] {
  const b = frameBox(frame, width, height);
  return placementCorners(b.center, b.width, b.height, b.rotation);
}

export function frameCenter(frame: SafeFrame, width: number, height: number): Vec {
  return frameBox(frame, width, height).center;
}

/**
 * The print area a given mockup actually uses: its own override when the frame is
 * unlocked, otherwise the project's shared one.
 */
export function effectiveFrame(
  projectFrame: SafeFrame | null,
  mockupFrame: SafeFrame | null | undefined,
): SafeFrame | null {
  return mockupFrame ?? projectFrame;
}

/** Wrap degrees into (-180, 180]. */
export function normalizeAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * How far the *rotated* box reaches, as a fraction of the mockup. Rotation mixes
 * the two axes, so the aspect ratio of the mockup has to come along for the ride.
 */
function rotatedExtent(
  w: number,
  h: number,
  rotation: number,
  dims?: { width: number; height: number },
): { bw: number; bh: number } {
  if (!rotation) return { bw: w, bh: h };
  const rad = deg2rad(rotation);
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const ar = dims ? dims.height / Math.max(dims.width, 1e-6) : 1;
  return { bw: w * c + h * s * ar, bh: (w * s) / ar + h * c };
}

/**
 * Keep a frame non-degenerate and inside the mockup, holding its centre steady.
 * Pass the mockup size so a rotated box is clamped by its true bounding box.
 */
export function normalizeFrame(
  frame: SafeFrame,
  dims?: { width: number; height: number },
): SafeFrame {
  const w = clamp(frame.w, MIN_FRAME, 1);
  const h = clamp(frame.h, MIN_FRAME, 1);
  const rotation = normalizeAngle(frame.rotation ?? 0);
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;

  const { bw, bh } = rotatedExtent(w, h, rotation, dims);
  // A box larger than the mockup cannot be clamped on both sides; centre it.
  const x = bw >= 1 ? 0.5 - w / 2 : clamp(cx, bw / 2, 1 - bw / 2) - w / 2;
  const y = bh >= 1 ? 0.5 - h / 2 : clamp(cy, bh / 2, 1 - bh / 2) - h / 2;

  return { x, y, w, h, rotation };
}

/** Snap the frame's centre to the mockup centre or borders while it is dragged. */
export function snapFrame(
  frame: SafeFrame,
  tol: number,
  dims?: { width: number; height: number },
): { frame: SafeFrame; guides: Guide[] } {
  const guides: Guide[] = [];
  let { x, y } = frame;
  const w = frame.w;
  const h = frame.h;

  const centerX = x + w / 2;
  if (Math.abs(centerX - 0.5) <= tol) {
    x = 0.5 - w / 2;
    guides.push({ axis: 'x', at: 0.5, from: 0, to: 1, space: 'norm' });
  } else if (Math.abs(x) <= tol) {
    x = 0;
    guides.push({ axis: 'x', at: 0, from: 0, to: 1, space: 'norm' });
  } else if (Math.abs(x + w - 1) <= tol) {
    x = 1 - w;
    guides.push({ axis: 'x', at: 1, from: 0, to: 1, space: 'norm' });
  }

  const centerY = y + h / 2;
  if (Math.abs(centerY - 0.5) <= tol) {
    y = 0.5 - h / 2;
    guides.push({ axis: 'y', at: 0.5, from: 0, to: 1, space: 'norm' });
  } else if (Math.abs(y) <= tol) {
    y = 0;
    guides.push({ axis: 'y', at: 0, from: 0, to: 1, space: 'norm' });
  } else if (Math.abs(y + h - 1) <= tol) {
    y = 1 - h;
    guides.push({ axis: 'y', at: 1, from: 0, to: 1, space: 'norm' });
  }

  return { frame: normalizeFrame({ ...frame, x, y }, dims), guides };
}

/**
 * Resize the print area by dragging a corner. Works through `resizeRect` so the
 * opposite corner stays anchored even when the area is already rotated.
 */
export function resizeFrame(
  start: SafeFrame,
  handle: CornerId,
  pointer: Vec,
  lockAspect: boolean,
  dims: { width: number; height: number },
): SafeFrame {
  const W = Math.max(1, dims.width);
  const H = Math.max(1, dims.height);
  const box = frameBox(start, W, H);

  const out = resizeRect(
    { center: box.center, width: box.width, height: box.height, rotation: box.rotation },
    handle,
    { x: pointer.x * W, y: pointer.y * H },
    lockAspect,
    Math.max(4, MIN_FRAME * Math.min(W, H)),
  );

  const w = out.width / W;
  const h = out.height / H;
  return normalizeFrame(
    {
      x: out.center.x / W - w / 2,
      y: out.center.y / H - h / 2,
      w,
      h,
      rotation: start.rotation ?? 0,
    },
    dims,
  );
}

/**
 * Where the print area's rotate grip sits: on a stalk off the top edge, or off
 * the bottom edge when the area sits too near the top of the mockup. The stalk is
 * squeezed rather than allowed to leave the canvas. `unit` is one screen pixel in
 * mockup pixels.
 */
export function frameRotateHandle(
  frame: SafeFrame,
  width: number,
  height: number,
  unit: number,
): { anchor: Vec; grip: Vec } {
  const box = frameBox(frame, width, height);
  const corners = frameCorners(frame, width, height);
  const topMid = {
    x: (corners[0].x + corners[1].x) / 2,
    y: (corners[0].y + corners[1].y) / 2,
  };
  const bottomMid = {
    x: (corners[2].x + corners[3].x) / 2,
    y: (corners[2].y + corners[3].y) / 2,
  };

  const want = ROTATE_OFFSET / unit;
  const margin = 8 * unit;
  const roomTop = topMid.y - margin;
  const roomBottom = height - bottomMid.y - margin;

  /** Stalk off `anchor`, pointing `outward` ('up' off the top edge, 'down' off the bottom). */
  const hang = (anchor: Vec, reach: number, outward: 'up' | 'down') => {
    if (reach <= 0) return { anchor, grip: anchor };
    const dir = rotateVec(outward === 'up' ? { x: 0, y: -1 } : { x: 0, y: 1 }, box.rotation);
    return { anchor, grip: { x: anchor.x + dir.x * reach, y: anchor.y + dir.y * reach } };
  };

  if (roomTop >= want) return hang(topMid, want, 'up');
  if (roomBottom >= want) return hang(bottomMid, want, 'down');

  // Neither side has a full-length stalk, so use the roomier one and shorten.
  const reach = Math.max(12 * unit, Math.min(want, Math.max(roomTop, roomBottom)));
  return roomTop >= roomBottom ? hang(topMid, reach, 'up') : hang(bottomMid, reach, 'down');
}

/**
 * Turn the print area by dragging its rotate handle. `step` snaps to that many
 * degrees (Shift); otherwise snapping pulls it onto the nearest right angle.
 */
export function rotateFrame(
  start: SafeFrame,
  rotationGrab: number,
  pointer: Vec,
  opts: { snapRightAngle?: boolean; step?: number },
): SafeFrame {
  const center = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  const angle = Math.atan2(pointer.y - center.y, pointer.x - center.x) - rotationGrab;
  let deg = (angle * 180) / Math.PI;

  if (opts.step) {
    deg = Math.round(deg / opts.step) * opts.step;
  } else if (opts.snapRightAngle) {
    const nearest = Math.round(deg / 90) * 90;
    if (Math.abs(deg - nearest) < 2.5) deg = nearest;
  }

  return { ...start, rotation: Math.round(normalizeAngle(deg) * 100) / 100 };
}

/** Signed area test: is p inside the (possibly rotated) rect? */
export function pointInRect(
  center: Vec,
  width: number,
  height: number,
  rotation: number,
  p: Vec,
): boolean {
  const l = toLocal(center, p, rotation);
  return Math.abs(l.x) <= width / 2 && Math.abs(l.y) <= height / 2;
}

export function rectsOverlap(
  a: { center: Vec; width: number; height: number; rotation: number },
  b: { center: Vec; width: number; height: number; rotation: number },
): boolean {
  const ca = placementCorners(a.center, a.width, a.height, a.rotation);
  const cb = placementCorners(b.center, b.width, b.height, b.rotation);
  for (let i = 0; i < 4; i++) {
    const p1 = ca[i];
    const p2 = ca[(i + 1) % 4];
    for (let j = 0; j < 4; j++) {
      if (segmentsIntersect(p1, p2, cb[j], cb[(j + 1) % 4])) return true;
    }
  }
  return cb.some((p) => pointInPolygon(p, ca)) || ca.some((p) => pointInPolygon(p, cb));
}

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Resize a rotated rect by dragging `handle` to `pointer`.
 * The opposite corner stays anchored. When `lockAspect` is true the sign of the
 * drag is preserved, so dragging past the anchor flips the shape.
 */
export function resizeRect(
  start: { center: Vec; width: number; height: number; rotation: number },
  handle: CornerId,
  pointer: Vec,
  lockAspect: boolean,
  minSize: number,
): { center: Vec; width: number; height: number } {
  const s = CORNER_SIGN[handle];
  const anchorLocal: Vec = { x: (-s.x * start.width) / 2, y: (-s.y * start.height) / 2 };
  const anchorWorld: Vec = {
    x: start.center.x + rotateVec(anchorLocal, start.rotation).x,
    y: start.center.y + rotateVec(anchorLocal, start.rotation).y,
  };
  const rawW = Math.abs(pointer.x - anchorWorld.x);
  const rawH = Math.abs(pointer.y - anchorWorld.y);
  const signX = pointer.x < anchorWorld.x ? -1 : 1;
  const signY = pointer.y < anchorWorld.y ? -1 : 1;

  let width = Math.max(minSize, rawW);
  let height = Math.max(minSize, rawH);

  if (lockAspect) {
    const aspect = start.width / Math.max(start.height, 1e-6);
    const byWidth = width / aspect;
    const byHeight = height * aspect;
    if (byWidth > byHeight) height = byWidth;
    else width = byHeight;
    width = Math.max(minSize, width);
    height = Math.max(minSize, height);
  }

  const newCenterLocal: Vec = {
    x: anchorLocal.x + (signX * width) / 2,
    y: anchorLocal.y + (signY * height) / 2,
  };
  const off = rotateVec(newCenterLocal, start.rotation);
  return {
    center: { x: anchorWorld.x + off.x, y: anchorWorld.y + off.y },
    width,
    height,
  };
}

export interface Guide {
  axis: 'x' | 'y';
  /** position in `space` units */
  at: number;
  from: number;
  to: number;
  /** 'px' is mockup pixel space, 'norm' is the 0..1 frame space. */
  space: 'px' | 'norm';
}

/**
 * Snap a placement to the mockup centre, edges, and 90° rotations.
 * `tol` is the snap distance already converted to mockup pixels.
 */
export function computeSnap(
  center: Vec,
  width: number,
  height: number,
  rotation: number,
  mockup: { width: number; height: number },
  tol: number,
): { center: Vec; rotation: number; guides: Guide[] } {
  const guides: Guide[] = [];
  let x = center.x;
  let y = center.y;
  let rot = rotation;

  const halfW = width / 2;
  const halfH = height / 2;
  const corners = placementCorners({ x, y }, width, height, rot);
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));

  if (Math.abs(x - mockup.width / 2) <= tol) {
    x = mockup.width / 2;
    guides.push({ axis: 'x', at: mockup.width / 2, from: 0, to: mockup.height, space: 'px' });
  } else if (Math.abs(minX) <= tol) {
    x = halfW;
    guides.push({ axis: 'x', at: 0, from: 0, to: mockup.height, space: 'px' });
  } else if (Math.abs(maxX - mockup.width) <= tol) {
    x = mockup.width - halfW;
    guides.push({ axis: 'x', at: mockup.width, from: 0, to: mockup.height, space: 'px' });
  }

  if (Math.abs(y - mockup.height / 2) <= tol) {
    y = mockup.height / 2;
    guides.push({ axis: 'y', at: mockup.height / 2, from: 0, to: mockup.width, space: 'px' });
  } else if (Math.abs(minY) <= tol) {
    y = halfH;
    guides.push({ axis: 'y', at: 0, from: 0, to: mockup.width, space: 'px' });
  } else if (Math.abs(maxY - mockup.height) <= tol) {
    y = mockup.height - halfH;
    guides.push({ axis: 'y', at: mockup.height, from: 0, to: mockup.width, space: 'px' });
  }

  const nearest = Math.round(rot / 90) * 90;
  if (Math.abs(rot - nearest) <= Math.min(3, tol / Math.max(width, height)) * 8 + 1.5) {
    rot = nearest;
  }

  return { center: { x, y }, rotation: rot, guides };
}

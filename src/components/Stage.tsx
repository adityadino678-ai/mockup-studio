import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import type { Mockup, Placement, SafeFrame } from '../types';
import {
  CORNERS,
  CORNER_SIGN,
  ROTATE_OFFSET,
  type CornerId,
  type Guide,
  type HandleId,
  type Vec,
  computeSnap,
  deg2rad,
  frameBox,
  frameCorners,
  frameRotateHandle,
  normalizeFrame,
  placementCorners,
  pointInRect,
  resizeFrame,
  resizeRect,
  rotateFrame,
  rotateHandlePoint,
  snapFrame,
  toLocal,
} from '../lib/geometry';
import { renderMockup } from '../lib/render';
import type { LoadedImage } from '../types';

type DragMode = 'move' | 'resize' | 'rotate';

interface DragState {
  mode: DragMode;
  handle: HandleId;
  designId: string;
  start: Placement;
  pointer0: Vec;
  center0: Vec;
  rotation0: number;
  rotationGrab: number;
}

interface FrameDragState {
  mode: 'move' | 'resize' | 'rotate';
  handle: CornerId | null;
  start: SafeFrame;
  pointer0: Vec;
  /** Angle between the frame centre and the pointer when the rotate drag began. */
  rotationGrab: number;
}

const MIN_SIZE = 12;

export function Stage(): JSX.Element {
  const project = useStore((s) => s.project);
  const images = useStore((s) => s.images);
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const aspectLock = useStore((s) => s.aspectLock);
  const snapEnabled = useStore((s) => s.snapEnabled);
  const frameMode = useStore((s) => s.frameMode);
  const patchPlacement = useStore((s) => s.patchPlacement);
  const patchFrame = useStore((s) => s.patchFrame);
  const beginGesture = useStore((s) => s.beginGesture);
  const endGesture = useStore((s) => s.endGesture);
  const setSnapEnabled = useStore((s) => s.setSnapEnabled);
  const setFrameMode = useStore((s) => s.setFrameMode);
  const saveDesignView = useStore((s) => s.saveDesignView);
  const getDesignView = useStore((s) => s.getDesignView);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameDragRef = useRef<FrameDragState | null>(null);
  const liveRef = useRef<{ designId: string; placement: Placement } | null>(null);
  const frameLiveRef = useRef<SafeFrame | null>(null);
  const guidesRef = useRef<Guide[]>([]);
  const viewRef = useRef({ scale: 1, panX: 0, panY: 0, autoFit: true });
  const prevDesignRef = useRef<string | null>(null);
  const [cursor, setCursor] = useState('default');
  const [zoomPct, setZoomPct] = useState(100);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const mockup = useMemo(
    () => project?.mockups.find((m) => m.id === selectedMockupId) ?? null,
    [project, selectedMockupId],
  );
  const mockupImage = mockup ? images.get(mockup.id) : undefined;
  const placement = mockup && selectedDesignId ? mockup.placements[selectedDesignId] : undefined;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { scale } = viewRef.current;
    const state = useStore.getState();
    const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
    if (!m) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const designs = new Map<string, LoadedImage>();
    for (const d of state.project!.designs) {
      const img = state.images.get(d.id);
      if (img) designs.set(d.id, img);
    }
    const image = state.images.get(m.id);
    if (!image) return;

    // One design per tab: the active tab's design is the only one composited.
    const activeDesignId = state.selectedDesignId;

    renderMockup(ctx, {
      mockup: {
        ...m,
        placements: liveRef.current
          ? { ...m.placements, [liveRef.current.designId]: liveRef.current.placement }
          : m.placements,
      },
      mockupImage: image,
      designs,
      scale: scale * dpr,
      background: '#0f1115',
      selectedDesignId: activeDesignId,
      onlyDesignId: activeDesignId,
      showSelection: true,
      guides: guidesRef.current,
      frame: frameLiveRef.current ?? m.frameOverride ?? state.project!.frame,
      frameActive: state.frameMode,
    });
  }, []);

  const redraw = () => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const m = useStore.getState().project?.mockups.find(
      (x) => x.id === useStore.getState().selectedMockupId,
    );
    if (!canvas || !host || !m) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pad = 48;
    const availW = Math.max(120, host.clientWidth - pad * 2);
    const availH = Math.max(120, host.clientHeight - pad * 2);
    if (viewRef.current.autoFit) {
      viewRef.current.scale = Math.min(availW / m.width, availH / m.height, 4);
    }
    const { scale, panX, panY } = viewRef.current;
    const cssW = m.width * scale;
    const cssH = m.height * scale;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.marginLeft = `${Math.round((availW - cssW) / 2 + panX)}px`;
    canvas.style.marginTop = `${Math.round((availH - cssH) / 2 + panY)}px`;
    draw();
  };

  // Each tab remembers its own zoom and pan, like switching browser windows.
  // Declared before the redraw effect so the restored view is used immediately.
  useEffect(() => {
    const prev = prevDesignRef.current;
    if (prev && prev !== selectedDesignId) {
      const v = viewRef.current;
      saveDesignView(prev, { scale: v.scale, panX: v.panX, panY: v.panY, autoFit: v.autoFit });
    }
    if (selectedDesignId && selectedDesignId !== prev) {
      const saved = getDesignView(selectedDesignId);
      viewRef.current = saved
        ? { scale: saved.scale, panX: saved.panX, panY: saved.panY, autoFit: saved.autoFit }
        : { scale: 1, panX: 0, panY: 0, autoFit: true };
    }
    prevDesignRef.current = selectedDesignId;
  }, [selectedDesignId, saveDesignView, getDesignView]);

  useEffect(() => {
    redraw();
    setZoomPct(Math.round(viewRef.current.scale * 100));
  }, [redraw, project, images, selectedMockupId, selectedDesignId, frameMode]);

  useEffect(() => {
    if (!readoutRef.current) return;
    readoutRef.current.textContent = placement
      ? `${Math.round(placement.x)}, ${Math.round(placement.y)} · ${Math.round(placement.width)}×${Math.round(
          placement.height,
        )} · ${Math.round(placement.rotation)}°`
      : '';
  }, [placement, selectedDesignId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(host);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [redraw]);

  const toMockupSpace = (e: { clientX: number; clientY: number }): Vec => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = viewRef.current.scale;
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  /** Rotate grip first, then corners, then "anywhere inside", for the print area. */
  const hitTestFrame = (
    pt: Vec,
    frame: SafeFrame,
    mockup: Mockup,
  ): { handle: CornerId | null; rotate: boolean; inside: boolean } => {
    const box = frameBox(frame, mockup.width, mockup.height);
    const tol = 9 / viewRef.current.scale;

    const { grip } = frameRotateHandle(frame, mockup.width, mockup.height, viewRef.current.scale);
    if (Math.hypot(grip.x - pt.x, grip.y - pt.y) <= tol) {
      return { handle: null, rotate: true, inside: true };
    }

    const corners = frameCorners(frame, mockup.width, mockup.height);
    for (let i = 0; i < corners.length; i++) {
      if (Math.hypot(corners[i].x - pt.x, corners[i].y - pt.y) <= tol) {
        return { handle: CORNERS[i], rotate: false, inside: true };
      }
    }
    return {
      handle: null,
      rotate: false,
      inside: pointInRect(box.center, box.width, box.height, box.rotation, pt),
    };
  };

  const currentFrame = (): SafeFrame | null => {
    if (frameLiveRef.current) return frameLiveRef.current;
    const state = useStore.getState();
    const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
    return m ? (m.frameOverride ?? state.project!.frame) : null;
  };

  const hitTest = (pt: Vec): { handle: HandleId | null; designId: string | null } => {
    const state = useStore.getState();
    const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
    if (!m) return { handle: null, designId: null };
    const screenTol = 9 / viewRef.current.scale;

    // Only the active tab's design exists on this canvas.
    const selId = state.selectedDesignId;
    if (selId) {
      const p = m.placements[selId];
      if (p?.visible) {
        const rot = rotateHandlePoint(
          { x: p.x, y: p.y },
          p.height,
          p.rotation,
          ROTATE_OFFSET / viewRef.current.scale,
        );
        if (Math.hypot(rot.x - pt.x, rot.y - pt.y) <= screenTol) return { handle: 'rot', designId: selId };
        const corners = placementCorners({ x: p.x, y: p.y }, p.width, p.height, p.rotation);
        for (let i = 0; i < CORNERS.length; i++) {
          if (Math.hypot(corners[i].x - pt.x, corners[i].y - pt.y) <= screenTol) {
            return { handle: CORNERS[i], designId: selId };
          }
        }
        const local = toLocal({ x: p.x, y: p.y }, pt, p.rotation);
        if (Math.abs(local.x) <= p.width / 2 && Math.abs(local.y) <= p.height / 2) {
          return { handle: null, designId: selId };
        }
      }
    }
    return { handle: null, designId: null };
  };

  const cursorFor = (handle: HandleId | null, p: Placement | undefined, hover: boolean): string => {
    if (panning) return 'grabbing';
    if (spaceDown) return 'grab';
    if (handle === 'rot') return 'grab';
    if (handle && p) {
      const s = CORNER_SIGN[handle as CornerId];
      const angle = Math.round((p.rotation % 180) / 45) * 45;
      let idx = 0;
      if (s.x !== 0) idx = 2;
      if (s.x !== 0 && s.y !== 0) idx = 1;
      const shifted = (idx + Math.round(angle / 45)) % 4;
      return ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'][shifted];
    }
    return hover ? 'move' : 'default';
  };

  const frameCursorFor = (
    handle: CornerId | null,
    rotate: boolean,
    inside: boolean,
  ): string => {
    if (rotate) return 'grab';
    if (!handle) return inside ? 'move' : 'default';
    return { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }[handle];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mockup) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 1 || spaceDown) {
      setPanning(true);
      dragRef.current = null;
      frameDragRef.current = null;
      return;
    }

    const pt = toMockupSpace(e);

    // Print-area mode takes priority, so the box can be drawn over a design.
    if (frameMode) {
      const frame = currentFrame();
      if (frame) {
        const { handle, rotate, inside } = hitTestFrame(pt, frame, mockup);
        if (handle || rotate || inside) {
          const center = {
            x: frame.x + frame.w / 2,
            y: frame.y + frame.h / 2,
          };
          frameDragRef.current = {
            mode: rotate ? 'rotate' : handle ? 'resize' : 'move',
            handle,
            start: frame,
            pointer0: pt,
            rotationGrab: rotate
              ? Math.atan2(pt.y / mockup.height - center.y, pt.x / mockup.width - center.x) -
                deg2rad(frame.rotation ?? 0)
              : 0,
          };
          frameLiveRef.current = frame;
          beginGesture();
          setCursor(frameCursorFor(handle, rotate, inside));
          return;
        }
      }
    }

    const { handle, designId } = hitTest(pt);
    if (!designId) return;

    const state = useStore.getState();
    const m = state.project!.mockups.find((x) => x.id === state.selectedMockupId)!;
    const start = { ...m.placements[designId] };
    if (!start) return;

    const mode: DragMode = handle === 'rot' ? 'rotate' : handle ? 'resize' : 'move';
    const center = { x: start.x, y: start.y };
    const rotationGrab =
      mode === 'rotate'
        ? Math.atan2(pt.y - center.y, pt.x - center.x) - deg2rad(start.rotation)
        : 0;

    dragRef.current = {
      mode,
      handle: handle ?? 'se',
      designId,
      start,
      pointer0: pt,
      center0: center,
      rotation0: start.rotation,
      rotationGrab,
    };
    liveRef.current = { designId, placement: start };
    beginGesture();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panning) {
      viewRef.current.panX += e.movementX;
      viewRef.current.panY += e.movementY;
      redraw();
      return;
    }
    if (!dragRef.current && !frameDragRef.current) {
      const pt = toMockupSpace(e);
      const state = useStore.getState();
      if (state.frameMode) {
        const frame = currentFrame();
        const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
        if (frame && m) {
          const hit = hitTestFrame(pt, frame, m);
          setCursor(frameCursorFor(hit.handle, hit.rotate, hit.inside));
          return;
        }
      }
      const { handle, designId } = hitTest(pt);
      const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
      const p = designId && m ? m.placements[designId] : undefined;
      setCursor(cursorFor(handle, p, Boolean(designId)));
      return;
    }

    const pt = toMockupSpace(e);
    const m = useStore.getState().project!.mockups.find((x) => x.id === useStore.getState().selectedMockupId)!;
    const scale = viewRef.current.scale;
    const tol = 6 / scale;
    guidesRef.current = [];

    const frameDrag = frameDragRef.current;
    if (frameDrag) {
      const pointerNorm = { x: pt.x / m.width, y: pt.y / m.height };
      const dims = { width: m.width, height: m.height };
      let next: SafeFrame;

      if (frameDrag.mode === 'rotate') {
        next = rotateFrame(frameDrag.start, frameDrag.rotationGrab, pointerNorm, {
          step: e.shiftKey ? 15 : undefined,
          snapRightAngle: !e.shiftKey && snapEnabled,
        });
      } else if (frameDrag.mode === 'resize' && frameDrag.handle) {
        next = resizeFrame(
          frameDrag.start,
          frameDrag.handle,
          pointerNorm,
          e.shiftKey ? !aspectLock : aspectLock,
          dims,
        );
      } else {
        next = normalizeFrame(
          {
            ...frameDrag.start,
            x: frameDrag.start.x + (pt.x - frameDrag.pointer0.x) / m.width,
            y: frameDrag.start.y + (pt.y - frameDrag.pointer0.y) / m.height,
          },
          dims,
        );
      }

      // Snapping the centre is meaningless once the box is turned, so it only
      // applies to an unrotated area.
      if (frameDrag.mode !== 'rotate' && snapEnabled && !e.altKey) {
        const snapped = snapFrame(next, tol / m.width, dims);
        frameLiveRef.current = snapped.frame;
        guidesRef.current = snapped.guides;
      } else {
        frameLiveRef.current = next;
      }

      setCursor(
        frameDrag.mode === 'rotate'
          ? 'grabbing'
          : frameDrag.mode === 'resize' && frameDrag.handle
            ? frameCursorFor(frameDrag.handle, false, true)
            : 'move',
      );
      if (readoutRef.current) {
        const f = frameLiveRef.current!;
        readoutRef.current.textContent =
          `print area ${Math.round(f.w * 100)}% × ${Math.round(f.h * 100)}% · at ${Math.round(
            f.x * 100,
          )}%, ${Math.round(f.y * 100)}% · ${Math.round(f.rotation ?? 0)}°`;
      }
      draw();
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    let next: Placement = { ...drag.start };
    guidesRef.current = [];

    if (drag.mode === 'move') {
      let dx = pt.x - drag.pointer0.x;
      let dy = pt.y - drag.pointer0.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      next.x = drag.start.x + dx;
      next.y = drag.start.y + dy;

      if (snapEnabled && !e.altKey) {
        const snapped = computeSnap({ x: next.x, y: next.y }, next.width, next.height, next.rotation, m, tol);
        next.x = snapped.center.x;
        next.y = snapped.center.y;
        next.rotation = snapped.rotation;
        guidesRef.current = snapped.guides;
      }
    } else if (drag.mode === 'resize') {
      const lock = e.shiftKey ? !aspectLock : aspectLock;
      const result = resizeRect(
        { center: { x: drag.center0.x, y: drag.center0.y }, width: drag.start.width, height: drag.start.height, rotation: drag.start.rotation },
        drag.handle as CornerId,
        pt,
        lock,
        MIN_SIZE,
      );
      next.x = result.center.x;
      next.y = result.center.y;
      next.width = result.width;
      next.height = result.height;

      if (snapEnabled && !e.altKey) {
        const snapped = computeSnap({ x: next.x, y: next.y }, next.width, next.height, next.rotation, m, tol);
        if (snapped.guides.length) {
          next.x = snapped.center.x;
          next.y = snapped.center.y;
          guidesRef.current = snapped.guides;
        }
      }
    } else {
      const center = drag.center0;
      const angle = Math.atan2(pt.y - center.y, pt.x - center.x) - drag.rotationGrab;
      let deg = (angle * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else if (snapEnabled) {
        const nearest = Math.round(deg / 90) * 90;
        if (Math.abs(deg - nearest) < 2.5) deg = nearest;
      }
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      next.rotation = Math.round(deg * 100) / 100;
    }

    liveRef.current = { designId: drag.designId, placement: next };
    setCursor(drag.mode === 'rotate' ? 'grabbing' : cursorFor(drag.handle, next, true));
    if (readoutRef.current) {
      readoutRef.current.textContent = `${Math.round(next.x)}, ${Math.round(next.y)} · ${Math.round(
        next.width,
      )}×${Math.round(next.height)} · ${Math.round(next.rotation)}°`;
    }
    draw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (panning) {
      setPanning(false);
      return;
    }
    const frameLive = frameLiveRef.current;
    if (frameDragRef.current) {
      frameDragRef.current = null;
      frameLiveRef.current = null;
      guidesRef.current = [];
      // One commit per drag, so undo steps back over the whole box movement.
      if (frameLive) patchFrame(frameLive);
      endGesture();
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      redraw();
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const live = liveRef.current;
    dragRef.current = null;
    liveRef.current = null;
    guidesRef.current = [];
    if (live) patchPlacement(live.designId, live.placement);
    endGesture();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    redraw();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!mockup) return;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const prev = viewRef.current.scale;
    const next = Math.min(16, Math.max(0.05, prev * factor));
    const ratio = next / prev;
    viewRef.current.scale = next;
    viewRef.current.autoFit = false;
    viewRef.current.panX *= ratio;
    viewRef.current.panY *= ratio;
    redraw();
  };

  const nudge = (dx: number, dy: number) => {
    const state = useStore.getState();
    if (!state.selectedDesignId) return;
    const m = state.project?.mockups.find((x) => x.id === state.selectedMockupId);
    const current = m?.placements[state.selectedDesignId];
    if (!current) return;
    state.patchPlacement(state.selectedDesignId, {
      x: Math.round(current.x + dx),
      y: Math.round(current.y + dy),
    });
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const state = useStore.getState();

      if (e.code === 'Space') {
        setSpaceDown(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedDesignId) {
          e.preventDefault();
          state.toggleVisible(state.selectedDesignId);
        }
        return;
      }
      if (e.key.toLowerCase() === 'f') {
        setFrameMode(!state.frameMode);
        return;
      }
      if (e.key === 'Tab' && state.project && state.project.designs.length > 1) {
        // Cycle tabs the way a browser does.
        e.preventDefault();
        const ids = state.project.designs.map((d) => d.id);
        const i = ids.indexOf(state.selectedDesignId ?? '');
        const next = e.shiftKey ? (i - 1 + ids.length) % ids.length : (i + 1) % ids.length;
        state.selectDesign(ids[next]);
        return;
      }
      if (e.key === '0') {
        viewRef.current.autoFit = true;
        viewRef.current.panX = 0;
        viewRef.current.panY = 0;
        redraw();
        return;
      }
      if (!state.selectedDesignId) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudge(-step, 0);
      else if (e.key === 'ArrowRight') nudge(step, 0);
      else if (e.key === 'ArrowUp') nudge(0, -step);
      else if (e.key === 'ArrowDown') nudge(0, step);
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  if (!project) return <div className="stage stage--empty" />;

  return (
    <div className="stage" ref={hostRef} onContextMenu={(e) => e.preventDefault()}>
      {!mockup || !mockupImage ? (
        <div className="stage__hint">
          <h2>No mockup selected</h2>
          <p>Upload mockup images in the left panel, then pick one below to start placing your design.</p>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="stage__canvas"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
      )}

      <div className="stage__toolbar">
        <button
          className="chip"
          onClick={() => {
            viewRef.current.autoFit = true;
            viewRef.current.panX = 0;
            viewRef.current.panY = 0;
            redraw();
          }}
          title="Fit to window (0)"
        >
          Fit
        </button>
        <button
          className="chip"
          onClick={() => (snapEnabled ? setSnapEnabled(false) : setSnapEnabled(true))}
          title="Toggle snapping"
        >
          Snap {snapEnabled ? 'on' : 'off'}
        </button>
        <span className="chip chip--static">{Math.round(zoomPct)}%</span>
      </div>

      <div className="stage__readout" ref={readoutRef} />
    </div>
  );
}

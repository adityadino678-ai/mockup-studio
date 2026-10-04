import { useState } from 'react';
import { useStore } from '../store/store';
import type { BlendMode, FitMode } from '../types';

const BLENDS: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'darken',
  'lighten',
];

const FITS: { value: FitMode; label: string; hint: string }[] = [
  { value: 'cover', label: 'Fill the area, crop overflow', hint: 'The design fills the print area edge to edge. Anything that does not fit is cut off.' },
  { value: 'contain', label: 'Fit inside, keep whole design', hint: 'The whole design stays visible, centred, with empty space where the shapes differ.' },
  { value: 'stretch', label: 'Stretch to fill', hint: 'No gaps and no cropping, but the artwork is distorted to match the area.' },
];

function num(value: number, digits = 0): string {
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  digits?: number;
  suffix?: string;
}): JSX.Element {
  const { label, value, onChange, step = 1, digits = 0, suffix } = props;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={num(value, digits)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix ? <em>{suffix}</em> : null}
    </label>
  );
}

export function Inspector(): JSX.Element {
  const project = useStore((s) => s.project);
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const linked = useStore((s) => s.linked);
  const setLinked = useStore((s) => s.setLinked);
  const aspectLock = useStore((s) => s.aspectLock);
  const setAspectLock = useStore((s) => s.setAspectLock);
  const patchPlacement = useStore((s) => s.patchPlacement);
  const patchAll = useStore((s) => s.patchAll);
  const resetPlacement = useStore((s) => s.resetPlacement);
  const refitDesign = useStore((s) => s.refitDesign);
  const refitEveryDesign = useStore((s) => s.refitEveryDesign);
  const resetFrame = useStore((s) => s.resetFrame);
  const patchFrame = useStore((s) => s.patchFrame);
  const setInspectorWidth = useStore((s) => s.setInspectorWidth);
  const toggleInspector = useStore((s) => s.toggleInspector);
  const [resizing, setResizing] = useState(false);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      setInspectorWidth(window.innerWidth - ev.clientX);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const mockup = project?.mockups.find((m) => m.id === selectedMockupId) ?? null;
  const design = project?.designs.find((d) => d.id === selectedDesignId) ?? null;
  const p = mockup && selectedDesignId ? mockup.placements[selectedDesignId] : undefined;
  const frame = (mockup?.frameOverride ?? project?.frame) ?? null;

  if (!project) return <aside className="inspector" />;

  return (
    <aside className="inspector">
      <div
        className={`resizer${resizing ? ' resizer--active' : ''}`}
        onPointerDown={startResize}
        onDoubleClick={() => setInspectorWidth(304)}
        title="Drag to resize · double-click to reset"
      />
      <header className="inspector__head">
        <h3>Placement</h3>
        <button className="icon" onClick={toggleInspector} title="Hide panel">
          ✕
        </button>
      </header>

      <label className="switch" title="Edit every mockup at once">
        <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
        <span>Link all mockups</span>
      </label>

      {!design ? (
        <p className="inspector__empty">Select a design on the canvas or in the left panel.</p>
      ) : (
        <>
          <div className="inspector__target">
            <strong>{design.name}</strong>
            <span>
              tab {project.designs.findIndex((d) => d.id === design.id) + 1} of{' '}
              {project.designs.length} · on {mockup?.name ?? 'no mockup'}
              {linked ? ' · linked' : ''}
            </span>
          </div>

          {p ? (
            <>
              <div className="grid2">
                <NumberField label="X" value={p.x} onChange={(x) => patchPlacement(design.id, { x })} />
                <NumberField label="Y" value={p.y} onChange={(y) => patchPlacement(design.id, { y })} />
                <NumberField
                  label="W"
                  value={p.width}
                  onChange={(width) => {
                    const aspect = design.height / Math.max(design.width, 1);
                    patchPlacement(design.id, aspectLock ? { width, height: width * aspect } : { width });
                  }}
                />
                <NumberField
                  label="H"
                  value={p.height}
                  onChange={(height) => {
                    const aspect = design.width / Math.max(design.height, 1);
                    patchPlacement(design.id, aspectLock ? { height, width: height * aspect } : { height });
                  }}
                />
                <NumberField
                  label="Rotation"
                  value={p.rotation}
                  digits={2}
                  onChange={(rotation) => patchPlacement(design.id, { rotation })}
                  suffix="°"
                />
                <NumberField
                  label="Opacity"
                  value={p.opacity * 100}
                  onChange={(v) => patchPlacement(design.id, { opacity: Math.max(0, Math.min(1, v / 100)) })}
                  suffix="%"
                />
              </div>

              {!p.linkedToFrame ? (
                <p className="warn warn--soft">
                  Moved by hand, so this design no longer follows the print area.{' '}
                  <button className="linkbtn" onClick={() => refitDesign(design.id)}>
                    Put it back
                  </button>
                </p>
              ) : null}

              <label className="field field--wide">
                <span>How it fills the print area</span>
                <select
                  value={p.fit}
                  onChange={(e) => patchPlacement(design.id, { fit: e.target.value as FitMode })}
                >
                  {FITS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <em className="hint">{FITS.find((f) => f.value === p.fit)?.hint}</em>
              </label>

              <label className="switch" title="Move the print area and this design follows it">
                <input
                  type="checkbox"
                  checked={p.linkedToFrame}
                  onChange={(e) =>
                    e.target.checked
                      ? refitDesign(design.id)
                      : patchPlacement(design.id, { linkedToFrame: false })
                  }
                />
                <span>Follow the print area</span>
              </label>

              <div className="row">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={aspectLock}
                    onChange={(e) => setAspectLock(e.target.checked)}
                  />
                  <span>Lock aspect</span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={p.flipX}
                    onChange={(e) => patchPlacement(design.id, { flipX: e.target.checked })}
                  />
                  <span>Flip X</span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={p.flipY}
                    onChange={(e) => patchPlacement(design.id, { flipY: e.target.checked })}
                  />
                  <span>Flip Y</span>
                </label>
              </div>

              <label className="field field--wide">
                <span>Blend</span>
                <select
                  value={p.blend}
                  onChange={(e) => patchPlacement(design.id, { blend: e.target.value as BlendMode })}
                >
                  {BLENDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>

              <div className="inspector__actions">
                <button
                  className="btn btn--primary"
                  disabled={!project.frame && !mockup?.frameOverride}
                  onClick={() => refitDesign(design.id)}
                  title="Snap this design back onto the print area"
                >
                  Fit to print area
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => patchPlacement(design.id, { x: mockup!.width / 2, y: mockup!.height / 2 })}
                  disabled={!mockup}
                >
                  Centre
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={!mockup}
                  onClick={() => {
                    const m = mockup!;
                    const scale = Math.max(m.width / design.width, m.height / design.height);
                    patchPlacement(design.id, {
                      x: m.width / 2,
                      y: m.height / 2,
                      width: design.width * scale,
                      height: design.height * scale,
                    });
                  }}
                >
                  Fill mockup
                </button>
                <button className="btn btn--ghost" onClick={() => resetPlacement(design.id)}>
                  Reset
                </button>
              </div>

              {!linked && (
                <button
                  className="btn btn--wide"
                  onClick={() =>
                    patchAll(design.id, {
                      x: p.x,
                      y: p.y,
                      width: p.width,
                      height: p.height,
                      rotation: p.rotation,
                      opacity: p.opacity,
                      flipX: p.flipX,
                      flipY: p.flipY,
                      fit: p.fit,
                    })
                  }
                >
                  Copy this placement to all {project.mockups.length} mockups
                </button>
              )}
            </>
          ) : (
            <p className="inspector__empty">No placement on this mockup yet.</p>
          )}
        </>
      )}

      <section className="inspector__section">
        <h4>Print area</h4>
        <p className="inspector__note">
          One adjustable border that every design lands inside, on every mockup, in every tab.
        </p>

        {frame ? (
          <>
            <div className="grid2">
              <NumberField
                label="Area W"
                value={frame.w * 100}
                onChange={(v) => patchFrame({ w: v / 100 })}
                suffix="%"
              />
              <NumberField
                label="Area H"
                value={frame.h * 100}
                onChange={(v) => patchFrame({ h: v / 100 })}
                suffix="%"
              />
              <NumberField
                label="Turn"
                value={frame.rotation ?? 0}
                digits={2}
                onChange={(rotation) => patchFrame({ rotation })}
                suffix="°"
              />
              <NumberField
                label="Centre X"
                value={(frame.x + frame.w / 2) * 100}
                onChange={(v) => patchFrame({ x: v / 100 - frame.w / 2 })}
                suffix="%"
              />
              <NumberField
                label="Centre Y"
                value={(frame.y + frame.h / 2) * 100}
                onChange={(v) => patchFrame({ y: v / 100 - frame.h / 2 })}
                suffix="%"
              />
            </div>
            <div className="row">
              <button
                className="btn btn--ghost"
                onClick={() => patchFrame({ rotation: 0 })}
                disabled={!frame.rotation}
              >
                Straighten
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => patchFrame({ rotation: 90 })}
                disabled={Math.round(frame.rotation ?? 0) === 90}
              >
                Turn 90°
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => patchFrame({ rotation: 45 })}
                disabled={Math.round(frame.rotation ?? 0) === 45}
              >
                Turn 45°
              </button>
            </div>
            <p className="inspector__note">
              Designs that follow the area turn with it. Or drag the round handle above the box on
              the canvas — hold Shift for 15° steps.
            </p>
          </>
        ) : null}

        <div className="inspector__actions">
          <button
            className="btn btn--ghost"
            onClick={refitEveryDesign}
            disabled={project.designs.length === 0 || !frame}
          >
            Re-fit all {project.designs.length} design{project.designs.length === 1 ? '' : 's'} to the area
          </button>
          <button className="btn btn--ghost" onClick={resetFrame}>
            Reset the area
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => project.designs.forEach((d) => patchAll(d.id, { visible: true }))}
            disabled={project.designs.length === 0}
          >
            Show every design
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => project.designs.forEach((d) => patchAll(d.id, { visible: false }))}
            disabled={project.designs.length === 0}
          >
            Hide every design
          </button>
        </div>
      </section>
    </aside>
  );
}

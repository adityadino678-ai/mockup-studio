import { useStore } from '../store/store';

/**
 * The print area ("border") controls. The area is shared by every mockup while
 * locked, so editing it in one tab moves every design on every mockup with it.
 */
export function FrameControls(): JSX.Element {
  const project = useStore((s) => s.project);
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const frameMode = useStore((s) => s.frameMode);
  const setFrameMode = useStore((s) => s.setFrameMode);
  const setFrameLocked = useStore((s) => s.setFrameLocked);
  const resetFrame = useStore((s) => s.resetFrame);
  const clearMockupFrameOverride = useStore((s) => s.clearMockupFrameOverride);

  if (!project) return <div className="framectl" />;

  const mockup = project.mockups.find((m) => m.id === selectedMockupId) ?? null;
  const overridden = Boolean(mockup?.frameOverride);
  const frame = overridden ? mockup!.frameOverride! : project.frame;

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="framectl">
      <button
        className={`chip${frameMode ? ' chip--on' : ''}`}
        onClick={() => setFrameMode(!frameMode)}
        title="Drag, resize or rotate the print area on the canvas (F). Drag the round handle to turn it."
      >
        ▭ Print area
      </button>

      <button
        className="chip"
        onClick={() => setFrameLocked(!project.frameLocked)}
        title={
          project.frameLocked
            ? 'Locked: the print area is the same on every mockup. Click to adjust one mockup only.'
            : 'Unlocked: this mockup has its own print area. Click to sync all of them again.'
        }
      >
        {project.frameLocked ? '🔒 All mockups' : '🔓 This mockup only'}
      </button>

      {overridden ? (
        <button
          className="chip"
          onClick={() => mockup && clearMockupFrameOverride(mockup.id)}
          title="Go back to the shared print area"
        >
          Use shared area
        </button>
      ) : null}

      {frame ? (
        <span className="framectl__size" title="Print area size, position and angle, as a share of the mockup">
          {pct(frame.w)} × {pct(frame.h)} · at {pct(frame.x)}, {pct(frame.y)}
          {Math.round(frame.rotation ?? 0) ? ` · ${Math.round(frame.rotation)}°` : ''}
        </span>
      ) : (
        <span className="framectl__size">No print area yet</span>
      )}

      <button className="chip" onClick={resetFrame} title="Back to a centred 80% area">
        Reset
      </button>
    </div>
  );
}

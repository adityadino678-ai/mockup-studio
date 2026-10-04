import { useEffect, useRef } from 'react';
import { useStore } from '../store/store';
import { FrameControls } from './FrameControls';

/**
 * One tab per design, like a browser window. The active tab is the only design
 * the stage draws, so each design gets its own editing surface and its own
 * export folder without any of them being composited together.
 */
export function DesignTabs(): JSX.Element {
  const project = useStore((s) => s.project);
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const selectDesign = useStore((s) => s.selectDesign);
  const removeDesign = useStore((s) => s.removeDesign);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when it changes from outside the tab bar.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const active = scroller?.querySelector('.dtabs__tab.is-active');
    if (scroller && active instanceof HTMLElement) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }, [selectedDesignId]);

  if (!project) return <div className="dtabs" />;

  return (
    <div className="dtabs">
      <div className="dtabs__scroller" ref={scrollerRef} role="tablist" aria-label="Designs">
        {project.designs.map((design) => {
          const active = design.id === selectedDesignId;
          return (
            <div
              key={design.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              title={`${design.name} — ${design.width}×${design.height}`}
              className={`dtabs__tab${active ? ' is-active' : ''}`}
              onClick={() => selectDesign(design.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectDesign(design.id);
                }
              }}
            >
              <span className="dtabs__name">{design.name}</span>
              {design.bgRemoved ? (
                <span className="dtabs__cut" title="Background removed">
                  ✂
                </span>
              ) : null}
              <button
                className="dtabs__close"
                title={`Close ${design.name}`}
                aria-label={`Close ${design.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeDesign(design.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}

        <button
          className="dtabs__add"
          title="Add another design as a new tab"
          onClick={() => document.getElementById('design-input')?.click()}
        >
          +
        </button>

        {project.designs.length === 0 ? (
          <p className="dtabs__empty">
            No designs yet — each one you add becomes its own tab.
          </p>
        ) : null}
      </div>

      <FrameControls />
    </div>
  );
}

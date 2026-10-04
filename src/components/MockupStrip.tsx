import { useMemo } from 'react';
import { useStore } from '../store/store';
import { MockupThumb } from './MockupThumb';
import type { LoadedImage } from '../types';

export function MockupStrip(): JSX.Element {
  const project = useStore((s) => s.project);
  const images = useStore((s) => s.images);
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const frameMode = useStore((s) => s.frameMode);
  const selectMockup = useStore((s) => s.selectMockup);
  const renameMockup = useStore((s) => s.renameMockup);

  const designs = useMemo(() => {
    const map = new Map<string, LoadedImage>();
    if (!project) return map;
    for (const d of project.designs) {
      const img = images.get(d.id);
      if (img) map.set(d.id, img);
    }
    return map;
  }, [project, images]);

  if (!project) return <div className="strip" />;

  return (
    <div className="strip">
      <div className="strip__head">
        <span>Mockups</span>
        <em>click to edit · the print area and this tab&apos;s design carry across all of them</em>
      </div>
      <div className="strip__scroller">
        {project.mockups.map((mockup, index) => {
          // Badge the active tab's design, not the whole stack.
          const shown = selectedDesignId ? mockup.placements[selectedDesignId] : undefined;
          return (
            <div
              key={mockup.id}
              className={`strip__item${mockup.id === selectedMockupId ? ' is-active' : ''}`}
            >
              <MockupThumb
                mockup={mockup}
                mockupImage={images.get(mockup.id)}
                designs={designs}
                maxHeight={104}
                active={mockup.id === selectedMockupId}
                onlyDesignId={selectedDesignId}
                frame={mockup.frameOverride ?? project.frame}
                frameActive={frameMode && mockup.id === selectedMockupId}
                badge={shown?.visible ? 'on' : 'empty'}
                onClick={() => selectMockup(mockup.id)}
              />
              <div className="strip__label">
                <span>{index + 1}</span>
                <input
                  value={mockup.name}
                  onChange={(e) => renameMockup(mockup.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          );
        })}
        {project.mockups.length === 0 ? (
          <p className="strip__empty">Add mockups to see them here.</p>
        ) : null}
      </div>
    </div>
  );
}

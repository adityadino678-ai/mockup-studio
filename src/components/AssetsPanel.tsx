import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { filesFromDataTransfer } from '../lib/files';
import { MockupThumb } from './MockupThumb';
import type { LoadedImage } from '../types';

type Tab = 'designs' | 'mockups';

export function AssetsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('designs');
  const project = useStore((s) => s.project);
  const images = useStore((s) => s.images);
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const selectDesign = useStore((s) => s.selectDesign);
  const selectMockup = useStore((s) => s.selectMockup);
  const addDesigns = useStore((s) => s.addDesigns);
  const addMockups = useStore((s) => s.addMockups);
  const removeDesign = useStore((s) => s.removeDesign);
  const removeMockup = useStore((s) => s.removeMockup);
  const toggleVisible = useStore((s) => s.toggleVisible);
  const autoRemoveBg = useStore((s) => s.autoRemoveBg);
  const setAutoRemoveBg = useStore((s) => s.setAutoRemoveBg);
  const removeDesignBackground = useStore((s) => s.removeDesignBackground);
  const busy = useStore((s) => s.busy);
  const lastImport = useStore((s) => s.lastImport);
  const clearLastImport = useStore((s) => s.clearLastImport);

  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);

  const designsMap = useMemo(() => {
    const map = new Map<string, LoadedImage>();
    if (!project) return map;
    for (const d of project.designs) {
      const img = images.get(d.id);
      if (img) map.set(d.id, img);
    }
    return map;
  }, [project, images]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setOver(false);
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;
      if (tab === 'designs') await addDesigns(files);
      else await addMockups(files);
    },
    [addDesigns, addMockups, tab],
  );

  if (!project) return <aside className="panel" />;

  const currentMockup = project.mockups.find((m) => m.id === selectedMockupId);

  return (
    <aside className="panel" onDragLeave={() => { dragDepth.current = 0; setOver(false); }}>
      <div className="panel__tabs">
        <button className={tab === 'designs' ? 'is-active' : ''} onClick={() => setTab('designs')}>
          Designs <span className="pill">{project.designs.length}</span>
        </button>
        <button className={tab === 'mockups' ? 'is-active' : ''} onClick={() => setTab('mockups')}>
          Mockups <span className="pill">{project.mockups.length}</span>
        </button>
      </div>

      <div
        className={`dropzone${over ? ' dropzone--over' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={onDrop}
        onClick={() =>
          document.getElementById(tab === 'designs' ? 'design-input' : 'mockup-input')?.click()
        }
      >
        <input
          id="design-input"
          type="file"
          accept="image/*,.psd,.psb,.tif,.tiff,.avif"
          multiple
          hidden
          onChange={(e) => {
            void addDesigns(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <input
          id="mockup-input"
          type="file"
          accept="image/*,.psd,.psb,.tif,.tiff,.avif"
          multiple
          hidden
          onChange={(e) => {
            void addMockups(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <strong>{tab === 'designs' ? 'Add designs' : 'Add mockups'}</strong>
        <span>
          {tab === 'designs'
            ? 'Drop logos / artwork here — folders work too'
            : 'Drop blank product mockups here — PNG, JPG or PSD'}
        </span>
        <em>PNG · JPG · WEBP · PSD</em>
      </div>

      {tab === 'designs' ? (
        <label className="switch" title="Runs an on-device AI model on every design you import">
          <input
            type="checkbox"
            checked={autoRemoveBg}
            onChange={(e) => setAutoRemoveBg(e.target.checked)}
          />
          <span>Remove backgrounds automatically</span>
        </label>
      ) : null}

      {busy ? <div className="panel__busy">{busy}</div> : null}

      {lastImport && lastImport.failed.length > 0 ? (
        <details className="importlog" open>
          <summary>
            {lastImport.added} added · {lastImport.failed.length} skipped
          </summary>
          <ul>
            {lastImport.failed.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <strong>{f.name}</strong>
                <span>{f.reason}</span>
              </li>
            ))}
          </ul>
          <button className="btn btn--ghost" onClick={clearLastImport}>
            Dismiss
          </button>
        </details>
      ) : null}

      <div className="panel__list">
        {tab === 'designs' &&
          project.designs.map((design) => {
            const img = designsMap.get(design.id);
            const placement = currentMockup?.placements[design.id];
            return (
              <div
                key={design.id}
                className={`asset${selectedDesignId === design.id ? ' asset--active' : ''}`}
                onClick={() => selectDesign(design.id)}
              >
                <div className="asset__preview">
                  {img ? <img src={img.url} alt="" draggable={false} /> : <span className="asset__pending" />}
                </div>
                <div className="asset__meta">
                  <input
                    className="asset__name"
                    value={design.name}
                    onChange={(e) =>
                      useStore.getState().update((p) => {
                        const d = p.designs.find((x) => x.id === design.id);
                        if (d) d.name = e.target.value;
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="asset__dims">
                    {design.width}×{design.height}
                    {design.bgRemoved ? ' · cut out' : ''}
                  </span>
                </div>
                <div className="asset__actions">
                  {!design.bgRemoved ? (
                    <button
                      title="Remove this design's background"
                      className="icon"
                      disabled={Boolean(busy)}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeDesignBackground(design.id);
                      }}
                    >
                      ✂
                    </button>
                  ) : null}
                  <button
                    title={placement?.visible ? 'Hide on this mockup' : 'Show on this mockup'}
                    className={`icon${placement?.visible ? ' icon--on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleVisible(design.id);
                    }}
                  >
                    {placement?.visible ? '◉' : '○'}
                  </button>
                  <button
                    title="Remove design"
                    className="icon icon--danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeDesign(design.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}

        {tab === 'mockups' &&
          project.mockups.map((mockup) => (
            <div
              key={mockup.id}
              className={`asset asset--row${selectedMockupId === mockup.id ? ' asset--active' : ''}`}
              onClick={() => selectMockup(mockup.id)}
            >
              <MockupThumb
                mockup={mockup}
                mockupImage={images.get(mockup.id)}
                designs={designsMap}
                maxHeight={54}
                active={selectedMockupId === mockup.id}
                onlyDesignId={selectedDesignId}
                frame={mockup.frameOverride ?? project.frame}
                onClick={() => selectMockup(mockup.id)}
              />
              <div className="asset__meta">
                <span className="asset__name asset__name--static">{mockup.name}</span>
                <span className="asset__dims">
                  {mockup.width}×{mockup.height}
                  {mockup.frameOverride ? ' · own print area' : ''}
                </span>
              </div>
              <div className="asset__actions">
                <button
                  title="Move up"
                  className="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().moveMockup(mockup.id, -1);
                  }}
                >
                  ↑
                </button>
                <button
                  title="Move down"
                  className="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().moveMockup(mockup.id, 1);
                  }}
                >
                  ↓
                </button>
                <button
                  title="Remove mockup"
                  className="icon icon--danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMockup(mockup.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}

        {tab === 'designs' && project.designs.length === 0 ? (
          <p className="panel__empty">
            No designs yet. Add your artwork — each one opens as its own tab above the canvas.
          </p>
        ) : null}
        {tab === 'mockups' && project.mockups.length === 0 ? (
          <p className="panel__empty">No mockups yet. Drop your blank product shots here.</p>
        ) : null}
      </div>
    </aside>
  );
}

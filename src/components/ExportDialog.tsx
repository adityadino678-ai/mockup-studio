import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import type { ExportSettings } from '../types';
import { MAX_CANVAS_EDGE, countExportPairs, downloadBlob, exportProject } from '../lib/export';

const PRESETS = [
  { label: 'Original size (1×)', scale: 1 },
  { label: 'Retina (2×)', scale: 2 },
  { label: 'Print 4×', scale: 4 },
  { label: 'Max 2000px wide', scale: 0 },
];

export function ExportDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)!;
  const selectedDesignId = useStore((s) => s.selectedDesignId);
  const notify = useStore((s) => s.notify);
  const [settings, setSettings] = useState<ExportSettings>({
    format: 'png',
    quality: 0.92,
    scale: 2,
    transparent: false,
    naming: '{mockup}',
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set(project.mockups.map((m) => m.id)));
  const [picked, setPicked] = useState<Set<string>>(() =>
    new Set(project.designs.map((d) => d.id)),
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const resolvedScale = useMemo(() => {
    if (settings.scale > 0) return settings.scale;
    const widest = Math.max(1, ...project.mockups.map((m) => m.width));
    return Math.min(8, 2000 / widest);
  }, [settings.scale, project.mockups]);

  const { designs: targetDesigns, mockups: targetMockups, count } = useMemo(
    () => countExportPairs(project, selected, picked),
    [project, selected, picked],
  );

  const oversize = targetMockups.filter(
    (m) => m.width * resolvedScale > MAX_CANVAS_EDGE || m.height * resolvedScale > MAX_CANVAS_EDGE,
  );

  const toggle = (set: Set<string>, id: string, on: boolean): Set<string> => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const run = async () => {
    if (count === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: count, current: '' });
    try {
      const result = await exportProject(
        project,
        { ...settings, scale: resolvedScale },
        setProgress,
        selected,
        picked,
      );
      downloadBlob(result.blob, `${project.name.replace(/[^\w\- ]+/g, '')}.zip`);
      notify(
        `Exported ${result.count} file${result.count === 1 ? '' : 's'} into ${targetDesigns.length} folder${
          targetDesigns.length === 1 ? '' : 's'
        }`,
      );
      if (result.clamped.length) {
        notify(`${result.clamped.length} image(s) were downscaled to fit browser canvas limits`);
      }
      onClose();
    } catch (err) {
      notify(`Export failed: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>Export mockups</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal__body">
          <p className="modal__note">
            One PNG per design per mockup, filed into a folder per design:
            <code>{project.name}/design-folder/mockup.png</code>
          </p>

          <div className="modal__row">
            <label className="field field--inline">
              <span>Format</span>
              <select
                value={settings.format}
                onChange={(e) =>
                  setSettings({ ...settings, format: e.target.value as ExportSettings['format'] })
                }
              >
                <option value="png">PNG (lossless)</option>
                <option value="jpeg">JPG (smaller)</option>
              </select>
            </label>

            <label className="field field--inline">
              <span>Size</span>
              <select
                value={settings.scale}
                onChange={(e) => setSettings({ ...settings, scale: Number(e.target.value) })}
              >
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.scale}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field field--inline">
              <span>Quality</span>
              <input
                type="range"
                min={0.4}
                max={1}
                step={0.02}
                value={settings.quality}
                disabled={settings.format === 'png'}
                onChange={(e) => setSettings({ ...settings, quality: Number(e.target.value) })}
              />
              <em>{Math.round(settings.quality * 100)}%</em>
            </label>
          </div>

          <label className="switch">
            <input
              type="checkbox"
              checked={settings.transparent}
              disabled={settings.format !== 'png'}
              onChange={(e) => setSettings({ ...settings, transparent: e.target.checked })}
            />
            <span>Transparent background (PNG only)</span>
          </label>

          <label className="field field--wide">
            <span>File name pattern</span>
            <input
              className="mono"
              value={settings.naming}
              onChange={(e) => setSettings({ ...settings, naming: e.target.value })}
            />
            <em className="hint">
              tokens: {'{project}'} {'{mockup}'} {'{design}'} {'{index}'} {'{total}'} {'{w}'} {'{h}'}{' '}
              {'{date}'}
            </em>
          </label>

          <div className="modal__row modal__row--top">
            <span className="modal__label">
              Design tabs <em>({targetDesigns.length} selected)</em>
            </span>
            <div className="modal__row-actions">
              <button
                className="btn btn--ghost"
                onClick={() => setPicked(new Set(project.designs.map((d) => d.id)))}
              >
                All
              </button>
              <button className="btn btn--ghost" onClick={() => setPicked(new Set())}>
                None
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => setPicked(new Set([selectedDesignId].filter(Boolean) as string[]))}
                disabled={!selectedDesignId}
                title="Only the tab you are looking at"
              >
                This tab
              </button>
              <button
                className="btn btn--ghost"
                onClick={() =>
                  setPicked(new Set(project.designs.filter((d) => d.bgRemoved).map((d) => d.id)))
                }
              >
                Only cut out
              </button>
            </div>
          </div>

          <div className="picker picker--tabs">
            {project.designs.map((d, i) => (
              <label
                key={d.id}
                className={`picker__item${picked.has(d.id) ? ' is-on' : ''}${
                  d.id === selectedDesignId ? ' is-current' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(d.id)}
                  onChange={(e) => setPicked((prev) => toggle(prev, d.id, e.target.checked))}
                />
                <span>{i + 1}</span>
                {d.name}
                {d.bgRemoved ? <em className="picker__tag">✂</em> : null}
              </label>
            ))}
            {project.designs.length === 0 ? <p className="panel__empty">No designs yet.</p> : null}
          </div>

          <div className="modal__row modal__row--top">
            <span className="modal__label">
              Mockups <em>({targetMockups.length} selected)</em>
            </span>
            <div className="modal__row-actions">
              <button
                className="btn btn--ghost"
                onClick={() => setSelected(new Set(project.mockups.map((m) => m.id)))}
              >
                All
              </button>
              <button className="btn btn--ghost" onClick={() => setSelected(new Set())}>
                None
              </button>
              <button
                className="btn btn--ghost"
                onClick={() =>
                  setSelected(
                    new Set(
                      project.mockups
                        .filter((m) => Object.values(m.placements).some((p) => p.visible))
                        .map((m) => m.id),
                    ),
                  )
                }
              >
                Only with designs
              </button>
            </div>
          </div>

          <div className="picker">
            {project.mockups.map((m, i) => (
              <label key={m.id} className={`picker__item${selected.has(m.id) ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  onChange={(e) => setSelected((prev) => toggle(prev, m.id, e.target.checked))}
                />
                <span>{i + 1}</span>
                {m.name}
              </label>
            ))}
            {project.mockups.length === 0 ? <p className="panel__empty">No mockups yet.</p> : null}
          </div>

          {oversize.length ? (
            <p className="warn">
              {oversize.length} mockup(s) exceed the {MAX_CANVAS_EDGE}px browser canvas limit at{' '}
              {Math.round(resolvedScale * 100)}% and will be exported slightly smaller.
            </p>
          ) : null}

          {running ? (
            <div className="progress">
              <div
                className="progress__bar"
                style={{
                  width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 10}%`,
                }}
              />
              <span>
                {progress.current} ({progress.done}/{progress.total})
              </span>
            </div>
          ) : null}
        </div>

        <footer className="modal__foot">
          <span className="modal__summary">
            {targetDesigns.length} design folder{targetDesigns.length === 1 ? '' : 's'} ·{' '}
            {count} file{count === 1 ? '' : 's'}
          </span>
          <button className="btn btn--ghost" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void run()}
            disabled={running || count === 0}
          >
            {running ? 'Rendering…' : `Download ${count} file${count === 1 ? '' : 's'} as ZIP`}
          </button>
        </footer>
      </div>
    </div>
  );
}

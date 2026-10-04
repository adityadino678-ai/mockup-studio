import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';

export function TopBar({
  onExport,
  onListings,
}: {
  onExport: () => void;
  onListings: () => void;
}): JSX.Element {
  const project = useStore((s) => s.project);
  const projects = useStore((s) => s.projects);
  const renameProject = useStore((s) => s.renameProject);
  const openProject = useStore((s) => s.openProject);
  const createProject = useStore((s) => s.createProject);
  const removeProject = useStore((s) => s.removeProject);
  const duplicateProject = useStore((s) => s.duplicateProject);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.history.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggleInspector = useStore((s) => s.toggleInspector);
  const toast = useStore((s) => s.toast);
  const notify = useStore((s) => s.notify);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => notify(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast, notify]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" aria-hidden />
        <strong>Mockup Studio</strong>
      </div>

      <div className="topbar__project">
        <div className="menu" ref={menuRef}>
          <button className="btn btn--ghost" onClick={() => setMenuOpen((v) => !v)}>
            Projects ▾
          </button>
          {menuOpen ? (
            <div className="menu__panel">
              <div className="menu__list">
                {projects.map((p) => (
                  <div key={p.id} className={`menu__row${p.id === project?.id ? ' is-on' : ''}`}>
                    <button
                      onClick={() => {
                        void openProject(p.id);
                        setMenuOpen(false);
                      }}
                    >
                      {p.name}
                    </button>
                    <button
                      title="Delete project"
                      className="icon icon--danger"
                      onClick={() => {
                        if (confirm(`Delete project “${p.name}” and all its images?`)) void removeProject(p.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="menu__foot">
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    void createProject(`Project ${projects.length + 1}`);
                    setMenuOpen(false);
                  }}
                >
                  + New
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    void duplicateProject();
                    setMenuOpen(false);
                  }}
                >
                  Duplicate
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <input
          className="topbar__name"
          value={project?.name ?? ''}
          placeholder="Project name"
          onChange={(e) => renameProject(e.target.value)}
        />
        <span className="topbar__count">
          {project?.designs.length ?? 0} design{project?.designs.length === 1 ? '' : 's'} ·{' '}
          {project?.mockups.length ?? 0} mockup{project?.mockups.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="topbar__right">
        <button className="btn btn--ghost" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          ↶ Undo
        </button>
        <button className="btn btn--ghost" onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
          ↷ Redo
        </button>
        <button
          className={`btn btn--ghost${inspectorOpen ? ' is-on' : ''}`}
          onClick={toggleInspector}
          title={inspectorOpen ? 'Hide the properties panel' : 'Show the properties panel'}
        >
          ▤ Panel
        </button>
        <button
          className="btn btn--ghost"
          onClick={onListings}
          disabled={!project || project.designs.length === 0}
          title="Turn these designs into Printify listings"
        >
          ⇪ Printify
        </button>
        <button
          className="btn btn--primary"
          onClick={onExport}
          disabled={!project || project.mockups.length === 0 || project.designs.length === 0}
          title="Pick which design tabs and mockups to export, one folder per design"
        >
          Export ↓
        </button>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </header>
  );
}

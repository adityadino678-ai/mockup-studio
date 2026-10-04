import { useEffect, useState } from 'react';
import { useStore } from './store/store';
import { TopBar } from './components/TopBar';
import { AssetsPanel } from './components/AssetsPanel';
import { Stage } from './components/Stage';
import { Inspector } from './components/Inspector';
import { MockupStrip } from './components/MockupStrip';
import { DesignTabs } from './components/DesignTabs';
import { ExportDialog } from './components/ExportDialog';
import { GlobalDrop } from './components/GlobalDrop';
import { ListingsPanel } from './components/listings/ListingsPanel';

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready);
  const storageError = useStore((s) => s.storageError);
  const bootstrap = useStore((s) => s.bootstrap);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const [showExport, setShowExport] = useState(false);
  const [showListings, setShowListings] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot__spinner" />
        <p>Opening your workspace…</p>
      </div>
    );
  }

  if (storageError) {
    return (
      <div className="boot">
        <h1>Storage unavailable</h1>
        <p>{storageError}</p>
        <p className="boot__note">
          Mockup Studio keeps your images on this device only, which needs IndexedDB.
          Turning off private browsing, or allowing site data, usually fixes it.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar onExport={() => setShowExport(true)} onListings={() => setShowListings(true)} />
      <main
        className={`layout${inspectorOpen ? '' : ' layout--no-inspector'}`}
        style={{ '--inspector-w': `${inspectorWidth}px` } as React.CSSProperties}
      >
        <AssetsPanel />
        <div className="workspace">
          <Stage />
          <DesignTabs />
          <MockupStrip />
        </div>
        <Inspector />
      </main>
      {showExport ? <ExportDialog onClose={() => setShowExport(false)} /> : null}
      {showListings ? <ListingsPanel onClose={() => setShowListings(false)} /> : null}
      <GlobalDrop />
    </div>
  );
}

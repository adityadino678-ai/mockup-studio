import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { filesFromDataTransfer } from '../lib/files';

/**
 * Window-level drag & drop. Without this the browser opens the dropped file
 * instead of importing it, and drops outside the small panel target do nothing.
 */
export function GlobalDrop(): JSX.Element | null {
  const addDesigns = useStore((s) => s.addDesigns);
  const addMockups = useStore((s) => s.addMockups);
  const ready = useStore((s) => s.ready);
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setCount(e.dataTransfer?.items?.length ?? 0);
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setActive(false);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, kind: 'design' | 'mockup') => {
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setActive(false);
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;
      if (kind === 'design') await addDesigns(files);
      else await addMockups(files);
    },
    [addDesigns, addMockups],
  );

  if (!ready || !active) return null;

  return (
    <div className="dropveil">
      <div className="dropveil__card">
        <h2>Drop {count || ''} file{count === 1 ? '' : 's'} to import</h2>
        <p>Pick what these files are — folders are supported.</p>
        <div className="dropveil__targets">
          <button
            className="dropveil__target"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void handleDrop(e, 'mockup')}
            onClick={() => document.getElementById('mockup-input')?.click()}
          >
            <strong>As mockups</strong>
            <span>Blank product shots, PSDs, scenes</span>
          </button>
          <button
            className="dropveil__target"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void handleDrop(e, 'design')}
            onClick={() => document.getElementById('design-input')?.click()}
          >
            <strong>As designs</strong>
            <span>Artwork, logos, print files</span>
          </button>
        </div>
      </div>
    </div>
  );
}

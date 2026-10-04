import { memo, useEffect, useRef } from 'react';
import type { LoadedImage, Mockup, SafeFrame } from '../types';
import { renderMockup } from '../lib/render';

interface Props {
  mockup: Mockup;
  mockupImage: LoadedImage | undefined;
  designs: Map<string, LoadedImage>;
  maxHeight: number;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  badge?: string;
  /** Show only this design, so a thumbnail matches the tab it sits under. */
  onlyDesignId?: string | null;
  /** Drawn faintly so you can see where the print area is. */
  frame?: SafeFrame | null;
  frameActive?: boolean;
}

function MockupThumbImpl({
  mockup,
  mockupImage,
  designs,
  maxHeight,
  active,
  onClick,
  onContextMenu,
  badge,
  onlyDesignId,
  frame,
  frameActive,
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const io = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((e) => e.isIntersecting);
      },
      { rootMargin: '200px' },
    );
    io.observe(host);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visibleRef.current || !mockupImage) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (maxHeight / mockup.height) * dpr;
    canvas.width = Math.max(1, Math.round(mockup.width * scale));
    canvas.height = Math.max(1, Math.round(mockup.height * scale));
    canvas.style.width = `${Math.round(mockup.width * (maxHeight / mockup.height))}px`;
    canvas.style.height = `${maxHeight}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderMockup(ctx, {
      mockup,
      mockupImage,
      designs,
      scale,
      background: '#ffffff',
      showSelection: false,
      onlyDesignId,
      frame,
      frameActive,
    });
  }, [mockup, mockupImage, designs, maxHeight, onlyDesignId, frame, frameActive]);

  return (
    <div
      ref={hostRef}
      className={`thumb${active ? ' thumb--active' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <canvas ref={canvasRef} />
      {badge ? <span className="thumb__badge">{badge}</span> : null}
    </div>
  );
}

export const MockupThumb = memo(MockupThumbImpl);

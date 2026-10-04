import type { SafeFrame } from '../../types';
import type { PrintifyPlaceholder, PrintifyVariant } from './types';

/**
 * Printify authors its design templates at 300 DPI, so a placeholder's pixel
 * size converts straight to a physical print size.
 */
export const TEMPLATE_DPI = 300;

export interface PhysicalSize {
  widthIn: number;
  heightIn: number;
  dpi: number;
}

/** A print area size in real inches, from the placeholder's pixel dimensions. */
export function physicalSize(placeholder: PrintifyPlaceholder): PhysicalSize {
  return {
    widthIn: placeholder.width / TEMPLATE_DPI,
    heightIn: placeholder.height / TEMPLATE_DPI,
    dpi: TEMPLATE_DPI,
  };
}

/**
 * Placeholders do not all measure the same. Blueprint 706 has three: S at
 * 3703px, M at 4107px, and L and up at 4494px. Each variant carries its own, so
 * the grouping has to read every variant rather than assume they match.
 */
export interface PlaceholderGroup {
  key: string;
  label: string;
  width: number;
  height: number;
  variantIds: number[];
}

export function groupPlaceholders(variants: PrintifyVariant[]): PlaceholderGroup[] {
  const bySize = new Map<string, PlaceholderGroup>();

  for (const variant of variants) {
    const ph = variant.placeholders[0];
    if (!ph) continue;
    const key = `${ph.width}x${ph.height}`;
    let group = bySize.get(key);
    if (!group) {
      group = { key, label: '', width: ph.width, height: ph.height, variantIds: [] };
      bySize.set(key, group);
    }
    group.variantIds.push(variant.id);
  }

  const sizeOf = new Map(variants.map((v) => [v.id, v.options.size]));
  return [...bySize.values()].map((g) => ({
    ...g,
    label: describeSizes(g.variantIds, sizeOf),
  }));
}

function describeSizes(
  variantIds: number[],
  sizesOf: Map<number, string | undefined>,
): string {
  const sizes = [
    ...new Set(variantIds.map((id) => sizesOf.get(id)).filter(Boolean)),
  ] as string[];
  if (sizes.length === 0) return 'all sizes';
  // S, M, L, XL -> "S-XL"; 2XL, 3XL, 4XL -> "2XL-4XL"
  const order = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  const sorted = sizes.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

/**
 * Turn the on-screen print area into Printify's placement numbers.
 *
 * Printify addresses the placeholder, not the garment, with (0,0) at its
 * top-left and (0.5,0.5) at its centre. `scale` is the artwork's width as a
 * fraction of the placeholder's width. We treat the mockup image the user
 * measured as the print area, which is what they see in the editor.
 *
 * The artwork is normalised to the print area's shape before upload (see
 * `prepareArtwork`), so the printed width is always the full area regardless of
 * which fit mode produced the file. The angle carries the area's rotation.
 */
export function frameToPlacement(frame: SafeFrame): {
  x: number;
  y: number;
  scale: number;
  angle: number;
} {
  return {
    x: round3(frame.x + frame.w / 2),
    y: round3(frame.y + frame.h / 2),
    scale: round3(frame.w),
    angle: Math.round(((frame.rotation ?? 0) % 360 + 360) % 360),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * How sharp the artwork will print at the requested size. Printify rejects very
 * low quality files with code 8203, so this is worth showing before uploading.
 */
export function effectiveDpi(
  artworkWidthPx: number,
  frame: SafeFrame,
  placeholder: PrintifyPlaceholder,
): number {
  const physical = physicalSize(placeholder);
  const printedWidthIn = frame.w * physical.widthIn;
  if (printedWidthIn <= 0) return 0;
  return Math.round(artworkWidthPx / printedWidthIn);
}

/** Below this, warn before an upload that Printify may bounce. */
export const DPI_WARN = 150;
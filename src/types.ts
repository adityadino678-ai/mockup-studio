export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'darken' | 'lighten';

/** How a design is mapped onto the print area when their aspect ratios differ. */
export type FitMode = 'cover' | 'contain' | 'stretch';

/**
 * The printable area of a mockup, normalised to 0..1 so one box fits mockups of
 * any pixel size. `x`/`y` are the top-left corner of the *unrotated* box, and
 * `rotation` turns it about its own centre.
 */
export interface SafeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** degrees */
  rotation: number;
}

export interface Design {
  id: string;
  name: string;
  blobKey: string;
  width: number;
  height: number;
  /** Set when the background was cut out on import. */
  bgRemoved?: boolean;
  /** The white-ink version of this design, for dark garments. */
  lightInk?: { blobKey: string; name: string };
  /** Which Printify placements this design should be printed at. */
  printPositions?: string[];
}

export interface Placement {
  designId: string;
  /** center position, in mockup pixel space */
  x: number;
  y: number;
  /** rendered size, in mockup pixel space */
  width: number;
  height: number;
  /** degrees */
  rotation: number;
  /** 0..1 */
  opacity: number;
  flipX: boolean;
  flipY: boolean;
  visible: boolean;
  blend: BlendMode;
  fit: FitMode;
  /** While true the placement is re-derived from the print area on every change. */
  linkedToFrame: boolean;
}

export interface Mockup {
  id: string;
  name: string;
  blobKey: string;
  width: number;
  height: number;
  /** placement per designId */
  placements: Record<string, Placement>;
  /** Only used while the print area is unlocked; null means "use the project's". */
  frameOverride?: SafeFrame | null;
}

/** Everything needed to turn this project into Printify listings. */
export interface PrintifyConfig {
  shopId: number | null;
  blueprintId: number | null;
  printProviderId: number | null;
  /** Product id whose prices and copy were copied in as a starting point. */
  templateProductId: string | null;
  /** blueprintId -> colour name -> 'light' | 'dark' | 'unset' */
  colourSides: Record<string, Record<string, 'light' | 'dark' | 'unset'>>;
  /** Colour names to enable, expanded to every size on the blueprint. */
  shortlist: string[];
  price: number;
  titleTemplate: string;
  descriptionTemplate: string;
  tagsTemplate: string;
  safetyTemplate: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  designs: Design[];
  mockups: Mockup[];
  /** Shared printable area. Null until the user draws one. */
  frame: SafeFrame | null;
  /** When true, editing the print area on one mockup edits it on all of them. */
  frameLocked: boolean;
  printify: PrintifyConfig;
}

export interface LoadedImage {
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
}

export interface ExportSettings {
  format: 'png' | 'jpeg';
  quality: number;
  scale: number;
  transparent: boolean;
  naming: string;
}

import type { Design, Project, SafeFrame } from '../../types';
import { frameToPlacement } from './placement';
import type {
  ColourSide,
  PrintifyCreateBody,
  PrintifyPlaceholderInput,
  PrintifyPrintArea,
  PrintifyVariant,
} from './types';

/** A design paired with the two ink files Printify needs. */
export interface DesignInkPair {
  design: Design;
  /** Artwork used on light garments, i.e. dark ink. */
  darkInk: { key: string; name: string };
  /** Artwork used on dark garments, i.e. white ink. Null means reuse darkInk. */
  lightInk: { key: string; name: string } | null;
  positions: string[];
}

export interface ListingTemplate {
  title: string;
  description: string;
  tags: string;
  safety: string;
}

export interface BuildPlanInput {
  project: Project;
  shopId: number;
  blueprintId: number;
  printProviderId: number;
  variants: PrintifyVariant[];
  /** Colour name -> light | dark | unset, for the blueprint being listed. */
  colourSides: Record<string, ColourSide>;
  /** Colour names to enable; every size of each is included. */
  shortlist: string[];
  pairs: DesignInkPair[];
  template: ListingTemplate;
  /** Price in cents, copied from an existing product unless overridden. */
  price: number;
  /** Which mockup's print area to read, since frames can differ per mockup. */
  frame: SafeFrame;
  /** frame -> position -> uploaded Printify image id */
  uploads: Record<string, Record<string, string>>;
}

export interface PlannedListing {
  designId: string;
  designName: string;
  title: string;
  /** Colours that will get the white-ink file. */
  lightInkColours: string[];
  /** Colours that will get the dark-ink file. */
  darkInkColours: string[];
  skippedColours: string[];
  missingLightInk: string[];
  body: PrintifyCreateBody;
  /** Warnings worth showing before anything is created. */
  warnings: string[];
}

export interface BuildPlanResult {
  listings: PlannedListing[];
  /** Set when the whole batch cannot run. */
  blocked: string | null;
}

/**
 * Turn the project into one create-product body per design.
 *
 * The interesting part is the ink split. Printify's `print_areas` is a list of
 * groups, and each group names the variants it applies to plus the images for
 * those variants. So a dark-ink group and a white-ink group in the same product
 * is exactly how "white print on black, black print on white" is expressed.
 */
export function buildPlan(input: BuildPlanInput): BuildPlanResult {
  const {
    project,
    blueprintId,
    printProviderId,
    variants,
    colourSides,
    shortlist,
    pairs,
    template,
    price,
    frame,
    uploads,
  } = input;

  const placement = frameToPlacement(frame);
  const wanted = new Set(shortlist.map((c) => c.toLowerCase()));

  const shortlisted = variants.filter((v) => {
    const colour = v.options.color;
    return colour ? wanted.has(colour.toLowerCase()) : false;
  });

  if (wanted.size === 0) {
    return { listings: [], blocked: 'Pick at least one colour in the shortlist first.' };
  }
  if (shortlisted.length === 0) {
    return {
      listings: [],
      blocked: `None of the ${wanted.size} shortlisted colours exist on this blueprint.`,
    };
  }

  const skippedColours = [...wanted].filter(
    (c) => !variants.some((v) => (v.options.color ?? '').toLowerCase() === c),
  );

  // A colour nobody has classified cannot be given the right ink, and a variant
  // with no print area would be listed and ship blank. So it is left out.
  const undecided = [
    ...new Set(
      shortlisted.filter((v) => {
        const side = colourSides[v.options.color ?? ''] ?? 'unset';
        return side === 'unset';
      }).map((v) => v.options.color ?? ''),
    ),
  ].sort();
  const chosen = shortlisted.filter((v) => {
    const side = colourSides[v.options.color ?? ''] ?? 'unset';
    return side !== 'unset';
  });

  const listings: PlannedListing[] = [];

  for (const pair of pairs) {
    const warnings: string[] = [];
    const bySide: Record<'light' | 'dark', number[]> = { light: [], dark: [] };

    if (undecided.length) {
      warnings.push(
        `${undecided.length} shortlisted colour${undecided.length === 1 ? '' : 's'} not marked light or dark yet, so ${undecided.length === 1 ? 'it is' : 'they are'} left out: ${undecided.join(', ')}.`,
      );
    }

    for (const variant of chosen) {
      const colour = variant.options.color ?? '';
      const side = colourSides[colour] ?? 'unset';
      if (side === 'unset') continue;
      bySide[side].push(variant.id);
    }

    // A dark garment printed with dark ink is invisible, so white ink is
    // required whenever any shortlisted colour needs it.
    const needsWhiteInk = bySide.light.length > 0 && !pair.lightInk;
    if (needsWhiteInk) {
      warnings.push(
        'White ink is needed for some garments but this design has no white-ink file, so those garments are left out.',
      );
    }

    const printAreas: PrintifyPrintArea[] = [];

    for (const side of ['dark', 'light'] as const) {
      let variantIds = bySide[side];
      if (side === 'light' && !pair.lightInk) variantIds = [];
      if (variantIds.length === 0) continue;
      const inkKey = side === 'dark' ? pair.darkInk.key : pair.lightInk!.key;
      if (!uploads[inkKey]) continue;
      const placeholders: PrintifyPlaceholderInput[] = [];
      for (const position of pair.positions) {
        const id = uploads[inkKey]?.[position];
        if (!id) continue;
        placeholders.push({ position, images: [{ id, ...placement }] });
      }
      if (placeholders.length === 0) continue;
      printAreas.push({ variant_ids: variantIds, placeholders });
    }

    if (printAreas.length === 0) {
      warnings.push('Nothing to place: the artwork for this design was not uploaded.');
    }

    // Only variants that actually appear in a print area are enabled. A variant
    // with no artwork would be listed for sale and arrive blank.
    const placed = new Set(printAreas.flatMap((area) => area.variant_ids));
    const enabled = chosen.filter((v) => placed.has(v.id));

    if (placed.size === 0) {
      warnings.push('No variants could be enabled, so this listing will not be created.');
    }

    // Printify documents a 100-variant ceiling per product.
    if (enabled.length > 100) {
      warnings.push(
        `${enabled.length} variants is over Printify's documented 100 per product. Trim the shortlist if the create fails.`,
      );
    }

    listings.push({
      designId: pair.design.id,
      designName: pair.design.name,
      title: fill(template.title, pair, project),
      lightInkColours: coloursFor(bySide.light, chosen),
      darkInkColours: coloursFor(bySide.dark, chosen),
      skippedColours,
      missingLightInk: needsWhiteInk ? coloursFor(bySide.light, chosen) : [],
      body: {
        title: fill(template.title, pair, project),
        description: fill(template.description, pair, project),
        blueprint_id: blueprintId,
        print_provider_id: printProviderId,
        variants: enabled.map((v) => ({ id: v.id, price, is_enabled: true })),
        print_areas: printAreas,
        ...parseTags(template.tags),
        ...(fill(template.safety, pair, project).trim()
          ? { safety_information: fill(template.safety, pair, project) }
          : {}),
      },
      warnings,
    });
  }

  return { listings, blocked: null };
}

function coloursFor(ids: number[], variants: PrintifyVariant[]): string[] {
  const wanted = new Set(ids);
  return [...new Set(variants.filter((v) => wanted.has(v.id)).map((v) => v.options.color ?? ''))].sort();
}

function parseTags(raw: string): { tags?: string[] } {
  const tags = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? { tags } : {};
}

/**
 * Template placeholders. Supported: {design}, {design_no_ext}, {slug},
 * {project}, {positions}, {position_count}. Anything left unrecognised is
 * stripped rather than sent literally, so a forgotten placeholder cannot leak
 * into a live listing title.
 */
function fill(template: string, pair: DesignInkPair, project: Project): string {
  const design = pair.design;
  return template
    .replace(/\{design\}/gi, design.name)
    .replace(/\{design_no_ext\}/gi, design.name.replace(/\.[^.]+$/, ''))
    .replace(/\{slug\}/gi, slugify(design.name))
    .replace(/\{project\}/gi, project.name)
    .replace(/\{positions\}/gi, pair.positions.join('+'))
    .replace(/\{position_count\}/gi, String(pair.positions.length))
    .replace(/\{[a-z_]+\}/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
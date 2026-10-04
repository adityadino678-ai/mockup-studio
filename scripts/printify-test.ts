/**
 * Tests for the Printify payload builder, run against the real shape of
 * blueprint 706 / provider 99: 450 variants, 66 colours, and print areas that
 * change with garment size (S 3703px, M 4107px, L and up 4494px).
 */

import { buildPlan } from '../src/lib/printify/plan';
import {
  frameToPlacement,
  groupPlaceholders,
  physicalSize,
  effectiveDpi,
  DPI_WARN,
} from '../src/lib/printify/placement';
import { requeueInterrupted, summarise, newJob, isComplete } from '../src/lib/printify/jobs';
import type { Design, Mockup, PrintifyVariant, Project } from '../src/types';
import type { ColourSide } from '../src/lib/printify/types';

let failures = 0;
let passes = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`, detail === undefined ? '' : detail);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  ok(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------------ fixture */

/** Reproduces blueprint 706's real size-to-print-area mapping. */
function makeVariants(colours: string[], sizes = ['S', 'M', 'L', 'XL', '2XL']): PrintifyVariant[] {
  const px: Record<string, [number, number]> = {
    S: [3703, 4200],
    M: [4107, 4658],
    L: [4494, 5097],
    XL: [4494, 5097],
    '2XL': [4494, 5097],
    '3XL': [4494, 5097],
    '4XL': [4494, 5097],
  };
  const out: PrintifyVariant[] = [];
  let id = 70000;
  for (const size of sizes) {
    const [w, h] = px[size];
    for (const colour of colours) {
      out.push({
        id: id++,
        title: `${size} / ${colour}`,
        options: { color: colour, size },
        decoration_methods: ['dtg'],
        placeholders: [
          { position: 'back', decoration_method: 'dtg', width: w, height: h },
          { position: 'front', decoration_method: 'dtg', width: w, height: h },
        ],
      } as PrintifyVariant);
    }
  }
  return out;
}

const COLOURS = ['Black', 'Navy', 'White', 'Granite', 'Butter'];
const variants = makeVariants(COLOURS);

function makeProject(designs: Design[]): Project {
  return {
    id: 'p1',
    name: 'Winter',
    createdAt: 0,
    updatedAt: 0,
    designs,
    mockups: [] as Mockup[],
    frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.8, rotation: 0 },
    frameLocked: true,
    printify: {
      shopId: 29026243,
      blueprintId: 706,
      printProviderId: 99,
      templateProductId: null,
      colourSides: {},
      shortlist: [],
      price: 2671,
      titleTemplate: '{design} | {positions}',
      descriptionTemplate: '',
      tagsTemplate: '',
      safetyTemplate: '',
    },
  };
}

const design: Design = {
  id: 'd1',
  name: 'Pine Trees.png',
  blobKey: 'blob-dark',
  width: 1024,
  height: 1024,
  printPositions: ['front'],
};

const lightDesign: Design = {
  ...design,
  lightInk: { blobKey: 'blob-light', name: 'Pine Trees white.png' },
};

const frame = { x: 0.1, y: 0.1, w: 0.8, h: 0.8, rotation: 0 };

const uploadsBoth = {
  'blob-dark': { front: 'img-dark-front' },
  'blob-light': { front: 'img-light-front' },
};

function sides(map: Record<string, ColourSide>): Record<string, ColourSide> {
  return map;
}

/* ------------------------------------------------------------- placement */

section('Print area -> Printify placement');
{
  const p = frameToPlacement(frame);
  eq('centre x is the middle of the box', p.x, 0.5);
  eq('centre y is the middle of the box', p.y, 0.5);
  eq('scale is the box width', p.scale, 0.8);
  eq('angle defaults to 0', p.angle, 0);

  const off = frameToPlacement({ x: 0.2, y: 0.3, w: 0.5, h: 0.5, rotation: 30 });
  eq('an off-centre box keeps its centre', off.x, 0.45);
  eq('off-centre y', off.y, 0.55);
  eq('rotation carries through', off.angle, 30);

  const wrapped = frameToPlacement({ ...frame, rotation: 450 });
  eq('a 450 degree turn wraps to 90', wrapped.angle, 90);

  const negative = frameToPlacement({ ...frame, rotation: -90 });
  eq('a negative turn wraps positive', negative.angle, 270);
}

/* -------------------------------------------------------- physical sizes */

section('Physical print size');
{
  const small = { position: 'front', decoration_method: 'dtg', width: 3703, height: 4200 };
  const inches = physicalSize(small);
  eq('S print area is 12.3in wide', Math.round(inches.widthIn * 10) / 10, 12.3);
  eq('S print area is 14.0in tall', Math.round(inches.heightIn * 10) / 10, 14.0);

  const sizesOf = new Map<number, string | undefined>(variants.map((v) => [v.id, v.options.size]));
  const groups = groupPlaceholders(variants);
  eq('three distinct print areas', groups.length, 3);
  const labels = groups.map((g) => g.label).sort();
  ok('sizes are labelled correctly', JSON.stringify(labels) === JSON.stringify(['L-2XL', 'M', 'S']), labels);
  void sizesOf;

  // A 1024px design at 80% of the 3703px print area is well under 300 DPI.
  const dpi = effectiveDpi(1024, frame, small);
  ok(`low-res artwork is flagged (${dpi} DPI < ${DPI_WARN})`, dpi < DPI_WARN);
  const goodDpi = effectiveDpi(4000, frame, small);
  ok(`high-res artwork passes (${goodDpi} DPI)`, goodDpi > DPI_WARN);
}

/* ------------------------------------------------------------- ink split */

section('Dark ink vs white ink routing');
{
  const plan = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 29026243,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark', Navy: 'dark', White: 'light', Butter: 'light' }),
    shortlist: COLOURS,
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'Pine Trees.png' },
        lightInk: { key: 'blob-light', name: 'Pine Trees white.png' },
        positions: ['front'],
      },
    ],
    template: { title: '{design} | {positions}', description: '', tags: '', safety: '' },
    price: 2671,
    frame,
    uploads: uploadsBoth,
  });

  eq('one listing per design', plan.listings.length, 1);
  ok('nothing blocked', plan.blocked === null, plan.blocked);

  const listing = plan.listings[0];
  eq('title filled from template', listing.title, 'Pine Trees.png | front');

  eq('two print area groups', listing.body.print_areas.length, 2);
  const [darkGroup, lightGroup] = listing.body.print_areas;

  // 2 dark colours x 5 sizes = 10, 2 light colours x 5 sizes = 10.
  eq('dark group covers 10 variants', darkGroup.variant_ids.length, 10);
  eq('light group covers 10 variants', lightGroup.variant_ids.length, 10);
  eq('total enabled variants', listing.body.variants.length, 20);
  ok('every variant enabled', listing.body.variants.every((v) => v.is_enabled));
  eq('price applied to all', listing.body.variants[0].price, 2671);
  // Granite is on the shortlist but was never classified, so it must not appear.
  ok('an unclassified colour is not enabled', listing.body.variants.every((v) => {
    const c = variants.find((x) => x.id === v.id)?.options.color;
    return c !== 'Granite';
  }));

  eq('dark garments get the dark-ink image', darkGroup.placeholders[0].images[0].id, 'img-dark-front');
  eq('light garments get the white-ink image', lightGroup.placeholders[0].images[0].id, 'img-light-front');
  eq('placement position', darkGroup.placeholders[0].position, 'front');
  eq('placement x', darkGroup.placeholders[0].images[0].x, 0.5);
  eq('placement scale', darkGroup.placeholders[0].images[0].scale, 0.8);

  eq('reported dark ink colours', listing.darkInkColours.join(','), 'Black,Navy');
  eq('reported white ink colours', listing.lightInkColours.join(','), 'Butter,White');
}

section('Missing white-ink file is called out, not silently ignored');
{
  const plan = buildPlan({
    project: makeProject([design]),
    shopId: 29026243,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark', White: 'light', Butter: 'light' }),
    shortlist: ['Black', 'White', 'Butter'],
    pairs: [
      {
        design,
        darkInk: { key: 'blob-dark', name: 'Pine Trees.png' },
        lightInk: null,
        positions: ['front'],
      },
    ],
    template: { title: '{design}', description: '', tags: '', safety: '' },
    price: 2671,
    frame,
    uploads: { 'blob-dark': { front: 'img-dark-front' } },
  });

  const listing = plan.listings[0];
  ok('warns about the missing white-ink file', listing.warnings.some((w) => /white-ink/.test(w)), listing.warnings);
  eq('still lists which colours wanted white ink', listing.missingLightInk.join(','), 'Butter,White');
  eq('falls back to one group', listing.body.print_areas.length, 1);
}

section('Two positions');
{
  const plan = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 29026243,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark', White: 'light' }),
    shortlist: ['Black', 'White'],
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'x' },
        lightInk: { key: 'blob-light', name: 'y' },
        positions: ['front', 'back'],
      },
    ],
    template: { title: '{design}', description: '', tags: '', safety: '' },
    price: 1000,
    frame,
    uploads: {
      'blob-dark': { front: 'd-front', back: 'd-back' },
      'blob-light': { front: 'l-front', back: 'l-back' },
    },
  });
  const g = plan.listings[0].body.print_areas;
  eq('still two ink groups', g.length, 2);
  eq('each group carries both positions', g[0].placeholders.length, 2);
  eq('front and back mapped', g[0].placeholders.map((p) => p.position).join(','), 'front,back');
  eq('back uses its own image', g[0].placeholders[1].images[0].id, 'd-back');
}

/* ------------------------------------------------------------ edge cases */

section('Guards and edge cases');
{
  const none = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: {},
    shortlist: [],
    pairs: [],
    template: { title: '', description: '', tags: '', safety: '' },
    price: 1,
    frame,
    uploads: {},
  });
  ok('an empty shortlist is blocked', Boolean(none.blocked), none.blocked);

  const missingColour = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: {},
    shortlist: ['Neon Ultraviolet'],
    pairs: [],
    template: { title: '', description: '', tags: '', safety: '' },
    price: 1,
    frame,
    uploads: {},
  });
  ok('a colour not on the blueprint is blocked', Boolean(missingColour.blocked), missingColour.blocked);

  const unclassified = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'unset' }),
    shortlist: ['Black'],
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'x' },
        lightInk: { key: 'blob-light', name: 'y' },
        positions: ['front'],
      },
    ],
    template: { title: '{design}', description: '', tags: '', safety: '' },
    price: 1,
    frame,
    uploads: uploadsBoth,
  });
  eq('an undecided colour produces no variants', unclassified.listings[0].body.variants.length, 0);
  ok('and says so', unclassified.listings[0].warnings.some((w) => /light or dark/.test(w)));
}

section('Template filling');
{
  const plan = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark' }),
    shortlist: ['Black'],
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'x' },
        lightInk: null,
        positions: ['front', 'back'],
      },
    ],
    template: {
      title: '{design_no_ext} {slug} {positions} {position_count} {project} {nonsense}',
      description: 'Made in {project}',
      tags: 'shirt, winter , , trees',
      safety: '',
    },
    price: 1,
    frame,
    uploads: { 'blob-dark': { front: 'a' } },
  });
  const body = plan.listings[0].body;
  eq('body title is fully substituted', body.title, 'Pine Trees pine-trees front+back 2 Winter');
  ok('unknown placeholders are stripped, not sent literally', !body.title.includes('{'), body.title);
  eq('description filled', body.description, 'Made in Winter');
  eq('tags split and trimmed', body.tags?.join('|'), 'shirt|winter|trees');
  ok('empty safety text is left off', body.safety_information === undefined);
}

section('Shortlist expands to every size');
{
  const plan = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark', Navy: 'dark', White: 'light', Granite: 'dark', Butter: 'light' }),
    shortlist: ['Black', 'White'],
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'x' },
        lightInk: { key: 'blob-light', name: 'y' },
        positions: ['front'],
      },
    ],
    template: { title: 'x', description: '', tags: '', safety: '' },
    price: 1,
    frame,
    uploads: uploadsBoth,
  });
  eq('2 colours x 5 sizes', plan.listings[0].body.variants.length, 10);
  eq('dark side is Black only', plan.listings[0].body.print_areas[0].variant_ids.length, 5);
  eq('white side is White only', plan.listings[0].body.print_areas[1].variant_ids.length, 5);
}

section('Case-insensitive shortlist');
{
  const plan = buildPlan({
    project: makeProject([lightDesign]),
    shopId: 1,
    blueprintId: 706,
    printProviderId: 99,
    variants,
    colourSides: sides({ Black: 'dark' }),
    shortlist: ['black'],
    pairs: [
      {
        design: lightDesign,
        darkInk: { key: 'blob-dark', name: 'x' },
        lightInk: null,
        positions: ['front'],
      },
    ],
    template: { title: 'x', description: '', tags: '', safety: '' },
    price: 1,
    frame,
    uploads: { 'blob-dark': { front: 'a' } },
  });
  eq('lowercase shortlist still matches', plan.listings[0].body.variants.length, 5);
}

section('Batch resume');
{
  const entries = [
    { designId: 'a', designName: 'A', title: 'A', state: 'created' as const, productId: 'p1', attempts: 1, updatedAt: 0 },
    { designId: 'b', designName: 'B', title: 'B', state: 'creating' as const, attempts: 1, updatedAt: 0 },
    { designId: 'c', designName: 'C', title: 'C', state: 'failed' as const, error: 'boom', attempts: 2, updatedAt: 0 },
  ];
  const job = newJob('j1', 1, 706, 99, entries);
  eq('not complete while work remains', isComplete(job), false);

  const resumed = requeueInterrupted(job);
  const byId = Object.fromEntries(resumed.entries.map((e) => [e.designId, e.state]));
  eq('a created entry is never resent', byId.a, 'created');
  eq('an interrupted entry goes back to pending', byId.b, 'pending');
  eq('a failed entry stays failed so it can be retried', byId.c, 'failed');

  const stats = summarise(resumed);
  eq('created count', stats.created, 1);
  eq('pending count', stats.pending, 1);
  eq('failed count', stats.failed, 1);
}

/* ----------------------------------------------------------------- report */

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} FAILED`} (${passes} passed)`);
if (failures > 0) process.exit(1);
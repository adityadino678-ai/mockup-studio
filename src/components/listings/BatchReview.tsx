import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { printifyApi, ProxyError } from '../../lib/printify/api';
import { blobToBase64, prepareArtwork } from '../../lib/printify/artwork';
import { DPI_WARN, effectiveDpi, groupPlaceholders, physicalSize } from '../../lib/printify/placement';
import { buildPlan, type DesignInkPair } from '../../lib/printify/plan';
import {
  isComplete,
  newJob,
  payloadSummary,
  requeueInterrupted,
  summarise,
  type JobEntry,
  type JobLog,
} from '../../lib/printify/jobs';
import type { PrintifyVariant } from '../../lib/printify/types';
import { uid } from '../../lib/id';
import * as db from '../../lib/db';

interface Props {
  variants: PrintifyVariant[];
  positions: string[];
  onDone: () => void;
}

/**
 * The last screen before anything is created: which design goes on which
 * position, which ink file each garment colour gets, and a dry-run preview of the
 * exact payloads. Nothing is sent until Create is pressed.
 */
export function BatchReview({ variants, positions, onDone }: Props): JSX.Element {
  const project = useStore((s) => s.project)!;
  const selectedMockupId = useStore((s) => s.selectedMockupId);
  const patchPrintify = useStore((s) => s.patchPrintify);
  const setDesignLightInk = useStore((s) => s.setDesignLightInk);
  const setDesignPositions = useStore((s) => s.setDesignPositions);
  const notify = useStore((s) => s.notify);
  const setBusy = useStore((s) => s.setBusy);

  const [uploads, setUploads] = useState<Record<string, Record<string, string>>>({});
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<JobLog | null>(null);
  const lightInputRef = useRef<HTMLInputElement>(null);
  const inkTargetRef = useRef<string | null>(null);

  const mockup = project.mockups.find((m) => m.id === selectedMockupId) ?? project.mockups[0];
  const frame = mockup ? (mockup.frameOverride ?? project.frame) : project.frame;

  const pairs: DesignInkPair[] = useMemo(
    () =>
      project.designs.map((design) => ({
        design,
        darkInk: { key: design.blobKey, name: design.name },
        lightInk: design.lightInk
          ? { key: design.lightInk.blobKey, name: design.lightInk.name }
          : null,
        positions: design.printPositions ?? ['front'],
      })),
    [project.designs],
  );

  const plan = useMemo(() => {
    if (!project.printify.blueprintId || !project.printify.printProviderId || !frame) {
      return { listings: [], blocked: 'Choose a blueprint and print provider first.' };
    }
    return buildPlan({
      project,
      shopId: project.printify.shopId ?? 0,
      blueprintId: project.printify.blueprintId,
      printProviderId: project.printify.printProviderId,
      variants,
      colourSides: project.printify.colourSides[String(project.printify.blueprintId)] ?? {},
      shortlist: project.printify.shortlist,
      pairs,
      template: {
        title: project.printify.titleTemplate,
        description: project.printify.descriptionTemplate,
        tags: project.printify.tagsTemplate,
        safety: project.printify.safetyTemplate,
      },
      price: project.printify.price,
      frame,
      uploads,
    });
  }, [project, variants, pairs, uploads, frame]);

  const groups = useMemo(() => groupPlaceholders(variants), [variants]);

  const smallest = groups.reduce<typeof groups[number] | null>(
    (acc, g) => (!acc || g.width < acc.width ? g : acc),
    null,
  );

  /**
   * Prepare one ink file for every chosen position and upload it. The file is
   * normalised to the print area's shape first, so what Printify prints is what
   * the canvas preview showed.
   */
  const uploadInk = async (designId: string, which: 'dark' | 'light') => {
    const design = project.designs.find((d) => d.id === designId);
    if (!design || !frame) return;
    const key = which === 'dark' ? design.blobKey : design.lightInk?.blobKey;
    if (!key) return;

    const positionList = design.printPositions ?? ['front'];
    const blob = await db.loadBlob(key);
    if (!blob) throw new Error('That design file is missing from local storage');

    setBusy(`Preparing artwork for ${design.name}…`);
    try {
      const result: Record<string, string> = {};
      for (const position of positionList) {
        const prepared = await prepareArtwork(blob, frame, 'cover');
        const dpi = smallest ? effectiveDpi(prepared.width, frame, {
          position,
          decoration_method: 'dtg',
          width: smallest.width,
          height: smallest.height,
        }) : 0;
        if (dpi && dpi < DPI_WARN) {
          notify(
            `${design.name} will print at about ${dpi} DPI. Printify may ask for a higher resolution file.`,
          );
        }
        const uploaded = await printifyApi.uploadImage(
          `${design.name.replace(/\.[^.]+$/, '')}-${which}-${position}.png`.replace(/[^\w.\- ]+/g, '-'),
          await blobToBase64(prepared.blob),
        );
        result[position] = uploaded.id;
      }
      setUploads((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), ...result } }));
      notify(`Uploaded ${design.name} (${which} ink) to Printify`);
    } finally {
      setBusy(null);
    }
  };

  const runBatch = async () => {
    const shopId = project.printify.shopId;
    if (!shopId) return;
    const started = job ?? requeueInterrupted(newJob(
      uid('job'),
      shopId,
      project.printify.blueprintId ?? 0,
      project.printify.printProviderId ?? 0,
      plan.listings.map<JobEntry>((l) => ({
        designId: l.designId,
        designName: l.designName,
        title: l.title,
        state: 'pending',
        attempts: 0,
        updatedAt: Date.now(),
      })),
    ));
    setJob(started);
    setRunning(true);

    try {
      for (const listing of plan.listings) {
        // Never resend work that already landed.
        const existing = started.entries.find((e) => e.designId === listing.designId);
        if (existing?.state === 'created') continue;

        const mark = (patch: Partial<JobEntry>) =>
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  entries: prev.entries.map((e) =>
                    e.designId === listing.designId ? { ...e, ...patch, updatedAt: Date.now() } : e,
                  ),
                }
              : prev,
          );

        mark({ state: 'creating', attempts: (existing?.attempts ?? 0) + 1 });
        try {
          const product = await printifyApi.createProduct(shopId, listing.body);
          mark({ state: 'created', productId: product.id, error: undefined });
        } catch (err) {
          mark({
            state: 'failed',
            error: err instanceof ProxyError ? err.message : (err as Error).message,
          });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const stats = job ? summarise(job) : null;

  return (
    <div className="batch">
      {/* ---------------------------------------------------- print area sizes */}
      <section className="batch__section">
        <h4>Print area in real inches</h4>
        <p className="muted muted--tight">
          Derived from Printify&rsquo;s own placeholder sizes at 300 DPI. The same percentage is sent
          for every size, so the print grows with the garment.
        </p>
        <div className="pillrow">
          {groups.length === 0 ? (
            <span className="muted">No variants loaded.</span>
          ) : (
            groups.map((g) => {
              const inches = physicalSize({
                position: 'front',
                decoration_method: 'dtg',
                width: g.width,
                height: g.height,
              });
              return (
                <span key={g.key} className="pill pill--big">
                  {g.label}: {inches.widthIn.toFixed(1)} &times; {inches.heightIn.toFixed(1)} in
                </span>
              );
            })
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- designs */}
      <section className="batch__section">
        <h4>Designs</h4>
        <div className="inklist">
          {project.designs.map((design) => {
            const chosen = design.printPositions ?? ['front'];
            const darkKey = design.blobKey;
            const lightKey = design.lightInk?.blobKey;
            return (
              <div key={design.id} className="inkrow">
                <div className="inkrow__name">
                  <strong>{design.name}</strong>
                  <span className="muted">
                    {design.width}&times;{design.height}
                  </span>
                </div>

                <div className="inkrow__positions">
                  {positions.map((position) => (
                    <label key={position} className="chip chip--check">
                      <input
                        type="checkbox"
                        checked={chosen.includes(position)}
                        onChange={(e) =>
                          setDesignPositions(
                            design.id,
                            e.target.checked
                              ? [...chosen, position]
                              : chosen.filter((p) => p !== position),
                          )
                        }
                      />
                      {position}
                    </label>
                  ))}
                </div>

                <div className="inkrow__inks">
                  <span className={`inkchip ${uploads[darkKey] ? 'is-on' : ''}`}>
                    dark ink
                    {uploads[darkKey] ? (
                      <button className="linkbtn" onClick={() => uploadInk(design.id, 'dark')}>
                        re-upload
                      </button>
                    ) : (
                      <button className="linkbtn" onClick={() => void uploadInk(design.id, 'dark')}>
                        upload
                      </button>
                    )}
                  </span>

                  <span className={`inkchip ${lightKey ? 'is-on' : ''}`}>
                    white ink
                    {lightKey ? (
                      <>
                        <em className="muted"> {design.lightInk!.name}</em>
                        <button className="linkbtn" onClick={() => void uploadInk(design.id, 'light')}>
                          {uploads[lightKey] ? 're-upload' : 'upload'}
                        </button>
                        <button className="linkbtn" onClick={() => void setDesignLightInk(design.id, null)}>
                          remove
                        </button>
                      </>
                    ) : (
                      <button
                        className="linkbtn"
                        onClick={() => {
                          inkTargetRef.current = design.id;
                          lightInputRef.current?.click();
                        }}
                      >
                        add file
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <input
          ref={lightInputRef}
          type="file"
          accept="image/png,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            const target = inkTargetRef.current;
            e.target.value = '';
            if (file && target) void setDesignLightInk(target, file);
          }}
        />
      </section>

      {/* ----------------------------------------------------------- listing text */}
      <section className="batch__section">
        <h4>Listing text</h4>
        <div className="grid2">
          <label className="field field--wide">
            <span>Title template</span>
            <input
              value={project.printify.titleTemplate}
              onChange={(e) => patchPrintify({ titleTemplate: e.target.value })}
            />
            <em className="hint">{'{design}'} {'{design_no_ext}'} {'{slug}'} {'{positions}'} {'{project}'}</em>
          </label>
          <label className="field field--wide">
            <span>Price (cents)</span>
            <input
              type="number"
              value={project.printify.price}
              onChange={(e) => patchPrintify({ price: Number(e.target.value) || 0 })}
            />
            <em className="hint">{(project.printify.price / 100).toFixed(2)} per variant</em>
          </label>
        </div>
        <label className="field field--wide">
          <span>Description</span>
          <textarea
            rows={3}
            value={project.printify.descriptionTemplate}
            onChange={(e) => patchPrintify({ descriptionTemplate: e.target.value })}
          />
        </label>
        <div className="grid2">
          <label className="field field--wide">
            <span>Tags (comma separated)</span>
            <input
              value={project.printify.tagsTemplate}
              onChange={(e) => patchPrintify({ tagsTemplate: e.target.value })}
            />
          </label>
          <label className="field field--wide">
            <span>Safety / GPSR</span>
            <textarea
              rows={3}
              value={project.printify.safetyTemplate}
              onChange={(e) => patchPrintify({ safetyTemplate: e.target.value })}
            />
          </label>
        </div>
      </section>

      {/* ------------------------------------------------------------- preview */}
      <section className="batch__section">
        <h4>Preview</h4>
        {plan.blocked ? (
          <p className="warn">{plan.blocked}</p>
        ) : (
          <>
            <p className="muted muted--tight">
              {plan.listings.length} listing{plan.listings.length === 1 ? '' : 's'} will be created as{' '}
              <strong>drafts</strong>. Nothing is published until you do it by hand in Printify.
            </p>
            {plan.listings.map((listing) => (
              <details key={listing.designId} className="preview">
                <summary>
                  <span className="preview__title">{listing.title}</span>
                  <span className="preview__counts">
                    {listing.darkInkColours.length} dark ink · {listing.lightInkColours.length} white
                    ink · {listing.body.variants.length} variants
                  </span>
                </summary>
                {listing.warnings.length ? (
                  <ul className="preview__warns">
                    {listing.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                {listing.lightInkColours.length ? (
                  <p className="muted muted--tight">
                    White ink on: {listing.lightInkColours.join(', ')}
                  </p>
                ) : null}
                <pre className="preview__json">{payloadSummary(listing.body)}</pre>
              </details>
            ))}
          </>
        )}
      </section>

      {/* --------------------------------------------------------------- create */}
      <section className="batch__section">
        {job ? (
          <div className="joblog">
            <div className="joblog__head">
              <strong>Batch</strong>
              <span className="muted">
                {stats?.created} created · {stats?.failed} failed · {stats?.pending} left
              </span>
            </div>
            <ul className="joblog__list">
              {job.entries.map((entry) => (
                <li key={entry.designId} className={`job job--${entry.state}`}>
                  <span className="job__state">{entry.state}</span>
                  <span className="job__name">{entry.title}</span>
                  {entry.error ? <em className="job__error">{entry.error}</em> : null}
                  {entry.productId ? <code className="job__id">{entry.productId}</code> : null}
                </li>
              ))}
            </ul>
            {isComplete(job) ? (
              <p className="muted">
                All done. Open Printify to check the mockups, then publish the listings yourself.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="batch__actions">
          <button className="btn btn--ghost" onClick={onDone}>
            Back
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void runBatch()}
            disabled={running || !project.printify.shopId || Boolean(plan.blocked)}
          >
            {running
              ? 'Creating…'
              : job && !isComplete(job)
                ? `Resume — ${summarise(job).pending} left`
                : `Create ${plan.listings.length} draft listing${plan.listings.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </section>
    </div>
  );
}
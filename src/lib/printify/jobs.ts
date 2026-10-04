import type { PrintifyCreateBody } from './types';

/**
 * Printify has no idempotency key, so a create that times out may or may not
 * have landed. Retrying blindly is how you end up with four copies of the same
 * listing.
 *
 * So the intent is written down *before* each create, and the batch can be
 * resumed: anything already `created` is never sent again. Because the title is
 * deterministic from the template, a duplicate can also be spotted and cleaned
 * up from the shop's product list.
 */
export type JobState = 'pending' | 'creating' | 'created' | 'failed' | 'skipped';

export interface JobEntry {
  /** Stable per design, so a resumed run recognises its own work. */
  designId: string;
  designName: string;
  title: string;
  state: JobState;
  productId?: string;
  error?: string;
  attempts: number;
  updatedAt: number;
}

export interface JobLog {
  id: string;
  shopId: number;
  blueprintId: number;
  printProviderId: number;
  startedAt: number;
  entries: JobEntry[];
}

export function newJob(
  id: string,
  shopId: number,
  blueprintId: number,
  printProviderId: number,
  entries: JobEntry[],
): JobLog {
  return {
    id,
    shopId,
    blueprintId,
    printProviderId,
    startedAt: Date.now(),
    entries,
  };
}

export function pendingEntries(job: JobLog): JobEntry[] {
  return job.entries.filter((e) => e.state === 'pending' || e.state === 'failed');
}

export function isComplete(job: JobLog): boolean {
  return job.entries.every((e) => e.state === 'created' || e.state === 'skipped');
}

export function summarise(job: JobLog): { created: number; failed: number; pending: number } {
  return {
    created: job.entries.filter((e) => e.state === 'created').length,
    failed: job.entries.filter((e) => e.state === 'failed').length,
    pending: job.entries.filter((e) => e.state === 'pending' || e.state === 'creating').length,
  };
}

/**
 * Guard against the duplicate case: after a resume, anything already marked
 * `created` is left alone, and a `creating` entry that never finished is reset
 * so it can be retried deliberately.
 */
export function requeueInterrupted(job: JobLog): JobLog {
  return {
    ...job,
    entries: job.entries.map((e) => (e.state === 'creating' ? { ...e, state: 'pending' } : e)),
  };
}

/** A compact record of what was sent, useful when a listing looks wrong. */
export function payloadSummary(body: PrintifyCreateBody): string {
  const groups = body.print_areas
    .map((area) => {
      const positions = area.placeholders
        .map((p) => `${p.position}(${p.images.map((i) => `${i.id}@${i.scale}`).join(',')})`)
        .join(' ');
      return `${area.variant_ids.length} variants → ${positions}`;
    })
    .join(' | ');
  return `${body.variants.length} variants · ${groups}`;
}
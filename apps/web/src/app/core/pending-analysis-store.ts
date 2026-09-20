/**
 * localStorage-backed record of an analysis that is still running.
 *
 * An analysis is charged and executed server-side the moment it is submitted,
 * so a page refresh (or an accidental reload) while one is in flight used to
 * lose the only handle the user had on it: the tab went back to idle and the
 * finished result was only reachable from History. Remembering the row id lets
 * both entry points pick the same run back up on load and finish watching it.
 *
 * Per-browser and per-flow — one upload run and one workspace run can be
 * remembered at a time, which is all either screen can have in flight.
 */
export type PendingAnalysisKind = 'upload' | 'workspace';

export interface PendingAnalysis {
  /** The analyses row id, which is what gets watched. */
  id: string;
  /** Epoch ms at submit time, used to drop entries too old to be worth resuming. */
  startedAt: number;
  /**
   * Workspace runs only: the chart the run was read from, so a resumed result
   * can be put back on that same chart rather than floating free.
   */
  chart?: {
    instrument: { id: string; symbol: string; name: string; exchange: string; logoUrl?: string };
    timeframe: string;
    lookbackDays: number;
  };
}

/**
 * How long a remembered run stays resumable. Comfortably past the pipeline's
 * own budget (the client gives up watching at 3 minutes), so anything older is
 * either finished — and readable from History — or stranded, and the API's
 * stranded-analysis sweeper owns it from there.
 */
const MAX_AGE_MS = 10 * 60_000;

function storageKey(kind: PendingAnalysisKind): string {
  return `analysis:pending:v1:${kind}`;
}

export function savePendingAnalysis(
  isBrowser: boolean,
  kind: PendingAnalysisKind,
  pending: PendingAnalysis,
): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(pending));
  } catch {
    // Storage full or unavailable (private browsing) — the run is simply not
    // resumable after a refresh, which is how this behaved before.
  }
}

export function clearPendingAnalysis(isBrowser: boolean, kind: PendingAnalysisKind): void {
  if (!isBrowser) return;
  try {
    localStorage.removeItem(storageKey(kind));
  } catch {
    /* Nothing to do: a stale entry expires on its own via MAX_AGE_MS. */
  }
}

/** Returns the remembered run, or null if there is none, it is unreadable, or it is too old. */
export function loadPendingAnalysis(
  isBrowser: boolean,
  kind: PendingAnalysisKind,
): PendingAnalysis | null {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(storageKey(kind));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PendingAnalysis> | null;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.startedAt !== 'number') {
      clearPendingAnalysis(isBrowser, kind);
      return null;
    }
    if (Date.now() - parsed.startedAt > MAX_AGE_MS) {
      clearPendingAnalysis(isBrowser, kind);
      return null;
    }
    return parsed as PendingAnalysis;
  } catch {
    return null;
  }
}

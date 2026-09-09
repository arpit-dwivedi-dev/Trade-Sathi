import { Injectable, inject } from '@angular/core';

import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';

/**
 * The subset of `analyses` a list view needs. Deliberately not the whole row:
 * support_levels/summary/etc. are only useful once a detail view exists.
 */
export type HistoryRow = Pick<
  AnalysisRow,
  | 'id'
  | 'created_at'
  | 'symbol'
  | 'symbol_raw'
  | 'instrument_type'
  | 'structure_state'
  | 'setup_format'
  | 'call_direction'
  | 'status'
  | 'source'
  | 'source_type'
  | 'timeframe'
  | 'emailed_at'
  | 'image_key'
  // The legacy pair, for rows analyzed before the structured-read prompts.
  // Their replacements (instrument_type, structure_state) are null on those
  // rows, and these are null on every row written since.
  | 'asset_class'
  | 'trend'
  // Promoted out of fundamentals_result, the same way call_direction is
  // promoted out of analysis_result — see that column's migration.
  | 'fundamentals_stance'
> & {
  /**
   * The catalogue instrument this row was run on, for its company name and
   * logo — null for a manual upload, which has no instrument_id to join on.
   * Supabase returns the joined row as an object here (a to-one FK), not the
   * array shape a to-many join would produce.
   *
   * Beyond the display columns (name/logo_url) it carries the instrument's
   * full identity (id, symbol, exchange, instrument_type) so a resolved row
   * can be reopened on the Analyze-by-Symbol or Fundamentals tab — HistoryRow
   * has no instrument_id of its own on which to join again.
   */
  instruments: {
    id: string;
    exchange: string;
    symbol: string;
    name: string;
    instrument_type: string;
    logo_url: string | null;
  } | null;
};

// `symbol` and `source` join the list because symbol_raw alone was not enough
// to label a row: a generated analysis (live chart, daily briefing) knows its
// canonical symbol even when the model read none off the image, and those rows
// all store source_type 'upload', so `source` is their only real provenance.
// `instruments(name, logo_url)` rides along on instrument_id so the Symbol
// column can show the company name and logo without a second round trip.
const HISTORY_COLUMNS =
  'id, created_at, symbol, symbol_raw, instrument_type, structure_state, setup_format, ' +
  'call_direction, status, source, source_type, timeframe, emailed_at, image_key, asset_class, trend, ' +
  'fundamentals_stance, instruments(id, exchange, symbol, name, instrument_type, logo_url)';

/**
 * Which provenances a listing is restricted to. 'all' is the absence of a
 * filter rather than a value, so it is spelled out here instead of being
 * represented by an empty array — an empty `in` list would match nothing.
 */
export type HistorySourceFilter = 'all' | 'manual' | 'live' | 'watchlist_daily' | 'fundamentals';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface HistoryDetail {
  row: AnalysisRow;
  patterns: AnalysisPattern[];
}

export interface HistoryPage {
  rows: HistoryRow[];
  nextCursor: string | null;
}

/** The (created_at, id) pair a cursor encodes — the last row of a page. */
interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(row: HistoryRow): string {
  const payload: CursorPayload = { createdAt: row.created_at, id: row.id };
  return btoa(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CursorPayload).createdAt === 'string' &&
      typeof (parsed as CursorPayload).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    // Falls through: an unreadable cursor is treated as "no cursor" below.
  }
  return null;
}

/**
 * Clamp to a sane page size. A caller-supplied limit must never reach the
 * query unbounded — an accidental (or abusive) limit=1000 would pull the
 * user's entire history in one round trip.
 */
function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly supabase = inject(SupabaseClientService);

  /**
   * Reads the signed-in user's analyses straight from Supabase — RLS already
   * scopes `analyses` to the owner, so this needs no backend endpoint. Same
   * client-read pattern the analyze poller uses.
   *
   * `cursor` is opaque to callers; only this service encodes/decodes it.
   */
  async fetchHistory(
    cursor?: string,
    limit: number = DEFAULT_LIMIT,
    source: HistorySourceFilter = 'all',
  ): Promise<HistoryPage> {
    const client = this.supabase.client;
    // SSR has no Supabase client (and no session); the browser refetches.
    if (!client) return { rows: [], nextCursor: null };

    const pageSize = normalizeLimit(limit);

    let query = client
      .from('analyses')
      .select(HISTORY_COLUMNS)
      // created_at alone is not unique — two rows can share a timestamp, which
      // would make page boundaries skip or duplicate rows. id breaks the tie.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      // One extra row: its presence is what tells us another page exists.
      // rows.length === pageSize cannot answer that when the total happens to
      // be an exact multiple of the page size.
      .limit(pageSize + 1);

    // Filtered in the query, not after the fetch: filtering a page client-side
    // would return fewer rows than asked for and make the cursor describe a
    // boundary the next page does not share.
    if (source !== 'all') {
      query = query.eq('source', source);
    }

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded) {
      // Tuple comparison (created_at, id) < (cursor.createdAt, cursor.id).
      // supabase-js has no native tuple operator, so it is spelled out; a plain
      // .lt('created_at', …) would drop the tie-breaker and reintroduce the
      // skip/duplicate bug the compound sort exists to prevent.
      query = query.or(
        `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
      );
    }

    const { data, error } = await query.returns<HistoryRow[]>();
    if (error) throw error;

    const fetched = data ?? [];
    const hasMore = fetched.length > pageSize;
    const rows = hasMore ? fetched.slice(0, pageSize) : fetched;

    return {
      rows,
      // Encode the last row of the *trimmed* page, not the probe row.
      nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows[rows.length - 1]) : null,
    };
  }

  /**
   * The full row plus its patterns, for the standalone report view of one list entry.
   * Same client-read path as fetchHistory — RLS scopes both tables to the
   * owner, so no backend endpoint is needed.
   */
  async fetchDetail(id: string): Promise<HistoryDetail> {
    const client = this.supabase.client;
    if (!client) throw new Error('Supabase client is unavailable');

    const { data: row, error } = await client
      .from('analyses')
      .select('*')
      .eq('id', id)
      .single<AnalysisRow>();
    if (error || !row) throw error ?? new Error('Analysis row not found');

    // Patterns exist only on rows analyzed before the current prompts, which
    // prohibit pattern names outright. Still fetched, because those rows are
    // the user's history and their report view still renders them.
    const { data: patterns, error: patternsError } = await client
      .from('analysis_patterns')
      .select('*')
      .eq('analysis_id', id)
      .returns<AnalysisPattern[]>();
    if (patternsError) throw patternsError;

    return { row, patterns: patterns ?? [] };
  }

  /**
   * Deletes one or more of the signed-in user's analyses. RLS's
   * analyses_delete_own restricts this to rows the caller owns, and
   * analysis_patterns rows cascade via their FK — nothing else to clean up
   * client-side.
   */
  async deleteAnalyses(ids: string[]): Promise<void> {
    const client = this.supabase.client;
    if (!client) throw new Error('Supabase client is unavailable');
    if (ids.length === 0) return;

    const { error } = await client.from('analyses').delete().in('id', ids);
    if (error) throw error;
  }
}

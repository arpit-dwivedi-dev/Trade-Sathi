/**
 * Shape of the rows this feature reads back from Supabase.
 *
 * Kept local to the feature rather than in `packages/shared` on purpose: the
 * API writes these columns through the service-role client and has no matching
 * type today, so there is only one call site. Move it to shared the moment the
 * backend needs the same shape.
 */
export interface AnalysisRow {
  id: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  source_type: 'paste' | 'upload';
  symbol_raw: string | null;
  symbol: string | null;
  asset_class: string | null;
  timeframe: string | null;
  trend: string | null;
  volatility: string | null;
  volume_reading: string | null;
  sentiment: string | null;
  support_levels: number[] | null;
  resistance_levels: number[] | null;
  call_direction: string | null;
  call_confidence: number | null;
  call_entry: number | null;
  call_invalidation: number | null;
  call_target: number | null;
  horizon_candles: number | null;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface AnalysisPattern {
  id: string;
  analysis_id: string;
  pattern_key: string;
  confidence: number | null;
  pattern_note: string | null;
}

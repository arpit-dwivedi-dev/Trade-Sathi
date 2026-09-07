import { Pipe, PipeTransform } from '@angular/core';

const TIMEFRAME_LABELS: Record<string, string> = {
  m1: '1 Minute',
  m5: '5 Minutes',
  m15: '15 Minutes',
  h1: '1 Hour',
  h4: '4 Hours',
  d1: 'Daily',
  w1: 'Weekly',
};

/** Spells out a chart timeframe code (e.g. 'd1') for a reader who doesn't know the shorthand. */
@Pipe({ name: 'timeframeLabel' })
export class TimeframeLabelPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '—';
    return TIMEFRAME_LABELS[value.toLowerCase()] ?? value;
  }
}

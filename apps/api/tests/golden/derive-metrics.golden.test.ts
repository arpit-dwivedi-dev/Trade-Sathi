import type { DerivedMetricKey, DerivedMetrics, Metric } from "@chartanalyzer/shared";
import { allFixtureSlugs, loadFixture, runPipeline, snapshotAll } from "./harness.js";

/** Object.entries widens to `any` here; this keeps the sweeps typed. */
function metricEntries(metrics: DerivedMetrics): [DerivedMetricKey, Metric][] {
  return Object.entries(metrics) as [DerivedMetricKey, Metric][];
}

/**
 * The golden set.
 *
 * Every fixture is raw statements captured from the upstream endpoints and
 * frozen. The snapshot covers value, period, basis AND reliability for every
 * metric — a right number with a wrong period label is a failing test here,
 * which is the whole point: the reports that motivated this rebuild had
 * correct raw numbers and wrong period labels.
 */
describe("deriveMetrics golden set", () => {
  for (const slug of allFixtureSlugs()) {
    it(`derives stable, fully-labelled metrics for ${slug}`, () => {
      const fixture = loadFixture(slug);
      const { metrics, profile, dataNotes } = runPipeline(fixture);

      expect({
        exchange: profile.exchange,
        fiscalYearEndMonth: profile.fiscalYearEndMonth,
        revenueLine: profile.revenueLine,
        displayUnit: profile.displayUnit,
        q4IsBalancingFigure: profile.q4IsBalancingFigure,
        reportingCurrency: profile.reportingCurrency,
        metrics: snapshotAll(metrics),
        dataNotes: dataNotes.map((n) => `${n.severity}: ${n.title}`),
      }).toMatchSnapshot();
    });

    it(`labels every metric with a period for ${slug}`, () => {
      const { metrics } = runPipeline(loadFixture(slug));
      for (const [key, metric] of metricEntries(metrics)) {
        // A metric without a period is a bug, whatever its reliability.
        expect(metric.period, `${key} carries no period`).toBeTruthy();
        expect(metric.currency, `${key} carries no currency`).toBeTruthy();
        if (metric.reliability === "missing") {
          expect(metric.value, `${key} is missing but carries a value`).toBeNull();
        }
      }
    });

    it(`never emits a bare forward multiple for ${slug}`, () => {
      const { metrics } = runPipeline(loadFixture(slug));
      const { forwardPe } = metrics;
      if (forwardPe.value !== null) {
        // The fiscal year must be named in the period, spelled out with its
        // months — never a bare "forward P/E" and never a bare "FY2027".
        expect(forwardPe.period).toMatch(/FY\d{4} \(\w{3} \d{4} – \w{3} \d{4}\)/);
      } else {
        expect(forwardPe.reliability).toBe("missing");
      }
    });

    it(`renders every fiscal-year label with its months for ${slug}`, () => {
      const { metrics } = runPipeline(loadFixture(slug));
      for (const [key, metric] of metricEntries(metrics)) {
        const bareFy = /FY\d{4}(?! \()/.exec(metric.period);
        expect(bareFy, `${key} carries a bare fiscal-year label: ${metric.period}`).toBeNull();
      }
    });
  }
});

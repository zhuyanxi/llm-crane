import { beforeAll, describe, expect, it } from 'vitest';
import { runReleaseGate, type ReleaseGateReport } from '../evals/releaseGate';

describe('release gate', () => {
  let gateReport: ReleaseGateReport;

  beforeAll(async () => {
    gateReport = await runReleaseGate();
  });

  it('routing samples pass without blocking failures', () => {
    expect(gateReport.routing.failed).toBe(0);
  });

  it('stage samples pass without blocking failures', () => {
    const stageTotalFailed = Object.values(gateReport.stages).reduce((sum, s) => sum + s.failed, 0);
    expect(stageTotalFailed).toBe(0);
  });

  it('gate passes and declares release ready', () => {
    expect(gateReport.gatePassed).toBe(true);
    expect(gateReport.releaseReady).toBe(true);
  });

  it('generates readable summary for release notes', () => {
    expect(gateReport.summary).toContain('Release Gate:');
    expect(gateReport.summary).toContain('Routing:');
    expect(gateReport.summary).toContain('Stages:');
    expect(gateReport.summary).toContain('structurizer:');
    expect(gateReport.summary).toContain('router:');
  });

  it('reports blocking failure detail when present', () => {
    if (gateReport.blockingFailures.length > 0) {
      for (const f of gateReport.blockingFailures) {
        expect(f).toHaveProperty('sampleId');
        expect(f).toHaveProperty('stage');
        expect(f).toHaveProperty('expected');
        expect(f).toHaveProperty('actual');
      }
    }
  });
});

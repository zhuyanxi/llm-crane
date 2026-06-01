import { beforeAll, describe, expect, it } from 'vitest';
import { runReleaseGate, runCostQualityReport, type ReleaseGateReport, type CostQualityReport } from '../evals/releaseGate';

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

describe('cost-quality report', () => {
  let cqReport: CostQualityReport;

  beforeAll(async () => {
    cqReport = await runCostQualityReport();
  });

  it('includes cost metrics: simple route ratio and savings estimate', () => {
    expect(cqReport.rulesV2.simpleRouteRatio).toBeGreaterThan(0);
    expect(cqReport.rulesV2.simpleRouteRatio).toBeLessThanOrEqual(1);
    expect(cqReport.costSavingsEstimate).toContain('tasks routed simple');
  });

  it('includes quality metrics: avg confidence and score dimensions', () => {
    expect(cqReport.rulesV2.avgConfidence).toBeGreaterThan(0);
    expect(cqReport.rulesV2.avgComplexityScore).toBeGreaterThan(0);
    expect(cqReport.rulesV2.avgRiskScore).toBeGreaterThanOrEqual(0);
    expect(cqReport.rulesV2.avgBudgetPressureScore).toBeGreaterThanOrEqual(0);
  });

  it('includes prompt version metadata for traceability', () => {
    expect(cqReport.promptVersions).toHaveProperty('structurizer');
    expect(cqReport.promptVersions).toHaveProperty('router');
    expect(cqReport.promptVersions).toHaveProperty('planner');
    expect(cqReport.promptVersions).toHaveProperty('verifier');
    expect(cqReport.promptVersions).toHaveProperty('executor');
  });

  it('gate status reflects release readiness', () => {
    expect(cqReport.gatePassed).toBe(true);
    expect(cqReport.releaseRecommendation).toContain('Release recommended');
  });

  it('generates printable markdown-format summary', () => {
    expect(cqReport.summary).toContain('Cost-Quality Report');
    expect(cqReport.summary).toContain('Prompt Versions:');
    expect(cqReport.summary).toContain('Rules-V2 Strategy:');
    expect(cqReport.summary).toContain('Simple route ratio');
    expect(cqReport.summary).toContain('Cost savings');
    expect(cqReport.summary).toContain('Gate:');
  });
});

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRUNING_EVAL_SAMPLES,
  buildContextPruningEvalContexts,
} from '../evals/contextPruningSamples';
import { applyContextBudgetPruning, scoreContextRelevance } from '../src/workspaceContext';

describe('context pruning eval samples', () => {
  for (const sample of CONTEXT_PRUNING_EVAL_SAMPLES) {
    it(`${sample.id} retains required information points`, () => {
      const ranked = scoreContextRelevance({
        task: sample.task,
        taskType: sample.taskType,
        templateId: sample.templateId,
        contexts: buildContextPruningEvalContexts(sample),
      });
      const pruned = applyContextBudgetPruning(ranked, sample.budget);
      const retainedContent = pruned.contexts.map((context) => context.content).join('\n');

      for (const infoPoint of sample.mustRetain) {
        expect(retainedContent).toContain(infoPoint);
      }

      if (sample.expectedDroppedUri) {
        expect(pruned.contexts.some((context) => context.uri === sample.expectedDroppedUri)).toBe(false);
      }

      expect(pruned.stageSummaries).toHaveLength(3);
      expect(pruned.stageSummaries.every((summary) => summary.selectedCount <= summary.totalCount)).toBe(true);
    });
  }
});

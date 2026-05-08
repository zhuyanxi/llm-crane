import { describe, expect, it } from 'vitest';
import { VERIFIER_SYSTEM_PROMPT, buildExecutorSystemPrompt, buildStructurizerSystemPrompt, getTaskTemplatePromptAsset } from '../src/index';

describe('task template prompt assets', () => {
  it('returns template-specific prompt assets when template is known', () => {
    const asset = getTaskTemplatePromptAsset('debug');

    expect(asset.templateId).toBe('debug');
    expect(buildStructurizerSystemPrompt('debug')).toContain('extract symptom');
    expect(buildExecutorSystemPrompt('debug')).toContain('prioritize root cause');
  });

  it('falls back to default prompt assets when template is unknown', () => {
    const asset = getTaskTemplatePromptAsset('unknown-template');

    expect(asset.templateId).toBe('default');
    expect(buildStructurizerSystemPrompt()).toContain('Convert user request into strict JSON.');
  });

  it('exports verifier system prompt with strict JSON contract', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Return strict JSON only');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('suggestedAction');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Do not reveal chain-of-thought');
  });
});
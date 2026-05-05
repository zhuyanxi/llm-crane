import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';
import { STRUCTURIZER_SYSTEM_PROMPT } from '@llm-crane/prompts';

export function startOrchestrator(): void {
  try {
    const config = loadRuntimeConfig(process.env);

    console.info('[llm-crane] orchestrator ready');
    console.info(`[llm-crane] simple=${config.defaultSimpleModel} complex=${config.defaultComplexModel}`);
    console.info(`[llm-crane] structurizer prompt chars=${STRUCTURIZER_SYSTEM_PROMPT.length}`);
  } catch (error) {
    const message = error instanceof ConfigurationError ? error.message : 'Unexpected orchestrator bootstrap error.';
    console.error(`[llm-crane] ${message}`);
    process.exitCode = 1;
  }
}

startOrchestrator();
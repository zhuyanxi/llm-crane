import { ARCHITECTURE_ANALYSIS_EXECUTOR_PROMPT_SECTIONS, ARCHITECTURE_ANALYSIS_STRUCTURIZER_PROMPT_SECTIONS } from './architectureAnalysis';
import { DEFAULT_EXECUTOR_PROMPT_SECTIONS, DEFAULT_STRUCTURIZER_PROMPT_SECTIONS } from './default';
import { DEBUG_EXECUTOR_PROMPT_SECTIONS, DEBUG_STRUCTURIZER_PROMPT_SECTIONS } from './debug';
import { REFACTOR_EXECUTOR_PROMPT_SECTIONS, REFACTOR_STRUCTURIZER_PROMPT_SECTIONS } from './refactor';

export type TaskTemplatePromptAsset = {
  templateId: string;
  structurizerInstructions: string[];
  executorInstructions: string[];
};

const DEFAULT_TASK_TEMPLATE_PROMPT_ASSET: TaskTemplatePromptAsset = {
  templateId: 'default',
  structurizerInstructions: [],
  executorInstructions: [],
};

export const V1_TASK_TEMPLATE_PROMPT_ASSETS: Record<string, TaskTemplatePromptAsset> = {
  refactor: {
    templateId: 'refactor',
    structurizerInstructions: REFACTOR_STRUCTURIZER_PROMPT_SECTIONS,
    executorInstructions: REFACTOR_EXECUTOR_PROMPT_SECTIONS,
  },
  debug: {
    templateId: 'debug',
    structurizerInstructions: DEBUG_STRUCTURIZER_PROMPT_SECTIONS,
    executorInstructions: DEBUG_EXECUTOR_PROMPT_SECTIONS,
  },
  'architecture-analysis': {
    templateId: 'architecture-analysis',
    structurizerInstructions: ARCHITECTURE_ANALYSIS_STRUCTURIZER_PROMPT_SECTIONS,
    executorInstructions: ARCHITECTURE_ANALYSIS_EXECUTOR_PROMPT_SECTIONS,
  },
};

function joinPromptSections(sections: string[]): string {
  return sections.join(' ');
}

export function getTaskTemplatePromptAsset(templateId?: string): TaskTemplatePromptAsset {
  if (!templateId) {
    return DEFAULT_TASK_TEMPLATE_PROMPT_ASSET;
  }

  return V1_TASK_TEMPLATE_PROMPT_ASSETS[templateId] ?? DEFAULT_TASK_TEMPLATE_PROMPT_ASSET;
}

export function buildStructurizerSystemPrompt(templateId?: string): string {
  const asset = getTaskTemplatePromptAsset(templateId);
  return joinPromptSections([...DEFAULT_STRUCTURIZER_PROMPT_SECTIONS, ...asset.structurizerInstructions]);
}

export function buildExecutorSystemPrompt(templateId?: string): string {
  const asset = getTaskTemplatePromptAsset(templateId);
  return joinPromptSections([...DEFAULT_EXECUTOR_PROMPT_SECTIONS, ...asset.executorInstructions]);
}
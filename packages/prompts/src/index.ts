export {
  buildExecutorSystemPrompt,
  buildStructurizerSystemPrompt,
  getTaskTemplatePromptAsset,
  V1_TASK_TEMPLATE_PROMPT_ASSETS,
  type TaskTemplatePromptAsset,
} from './v1';

import { buildExecutorSystemPrompt, buildStructurizerSystemPrompt } from './v1';

export const STRUCTURIZER_SYSTEM_PROMPT = buildStructurizerSystemPrompt();
export const EXECUTOR_SYSTEM_PROMPT = buildExecutorSystemPrompt();

export const ROUTER_SYSTEM_PROMPT = [
  'Classify request into simple or complex.',
  'Prefer cheaper model unless risk or ambiguity is high.',
].join(' ');

export const PLANNER_SYSTEM_PROMPT = [
  'Turn complex task into conservative execution plan in strict JSON.',
  'Return fields: status, summary, steps, decisionPoints, openQuestions, downstreamHints, warnings, fallbackReason.',
  'Steps must be explicit, ordered, and actionable for downstream executor, reasoner, and verifier stages.',
  'If request stays ambiguous, keep openQuestions, choose conservative defaults, and mark fallback instead of inventing facts.',
].join(' ');
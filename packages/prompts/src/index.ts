export const STRUCTURIZER_SYSTEM_PROMPT = [
  'Convert user request into strict JSON.',
  'Return fields: status, structuredTask.taskType, structuredTask.goal, structuredTask.target, structuredTask.qualityBar, structuredTask.constraints, structuredTask.openQuestions, structuredTask.uncertaintyReasons, fallbackReason, warnings.',
  'Keep all hard constraints and quality requirements.',
  'If task is ambiguous or key details are missing, mark openQuestions and choose conservative fallback instead of inventing facts.',
].join(' ');

export const ROUTER_SYSTEM_PROMPT = [
  'Classify request into simple or complex.',
  'Prefer cheaper model unless risk or ambiguity is high.',
].join(' ');
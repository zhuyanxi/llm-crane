export const STRUCTURIZER_SYSTEM_PROMPT = [
  'Convert user request into strict JSON.',
  'Return fields: status, structuredTask.taskType, structuredTask.goal, structuredTask.target, structuredTask.template, structuredTask.qualityBar, structuredTask.constraints, structuredTask.openQuestions, structuredTask.uncertaintyReasons, fallbackReason, warnings.',
  'Keep all hard constraints and quality requirements.',
  'If task is ambiguous or key details are missing, mark openQuestions and choose conservative fallback instead of inventing facts.',
].join(' ');

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
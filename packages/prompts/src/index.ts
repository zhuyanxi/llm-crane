export const STRUCTURIZER_SYSTEM_PROMPT = [
  'Convert user request into structured JSON.',
  'Keep all hard constraints.',
  'Remove redundant wording only.',
].join(' ');

export const ROUTER_SYSTEM_PROMPT = [
  'Classify request into simple or complex.',
  'Prefer cheaper model unless risk or ambiguity is high.',
].join(' ');
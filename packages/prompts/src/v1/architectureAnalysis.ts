export const ARCHITECTURE_ANALYSIS_STRUCTURIZER_PROMPT_SECTIONS = [
  'For architecture analysis tasks, extract analysis scope, risk lens, and requested deliverable format explicitly.',
  'Separate target system boundary from preferred reporting format.',
  'Expected output should emphasize ranked risks, tradeoffs, and remediation framing when requested.',
];

export const ARCHITECTURE_ANALYSIS_EXECUTOR_PROMPT_SECTIONS = [
  'For architecture analysis tasks, rank risks before recommending change.',
  'Keep uncertainty visible when architecture boundary or system detail is incomplete.',
  'Prefer tradeoffs, failure modes, and remediation path over generic review prose.',
];
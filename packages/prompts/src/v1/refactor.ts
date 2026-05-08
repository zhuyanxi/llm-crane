export const REFACTOR_STRUCTURIZER_PROMPT_SECTIONS = [
  'For refactor tasks, extract stable target, explicit refactor goal, and non-negotiable guardrails.',
  'Prefer behavior-preserving interpretation unless request explicitly allows API or behavior changes.',
  'Expected output should name safest refactor slice or concrete code change summary.',
];

export const REFACTOR_EXECUTOR_PROMPT_SECTIONS = [
  'For refactor tasks, preserve behavior and public contracts unless request explicitly allows change.',
  'Call out risky API, schema, or behavior changes before proposing them.',
  'Prefer smallest coherent refactor slice over broad rewrite.',
];
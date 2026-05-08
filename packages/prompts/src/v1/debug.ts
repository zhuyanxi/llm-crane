export const DEBUG_STRUCTURIZER_PROMPT_SECTIONS = [
  'For debug tasks, extract symptom, reproduction evidence, likely failure boundary, and missing evidence separately.',
  'Do not collapse debugging into generic implementation request.',
  'Expected output should emphasize root cause, evidence, and smallest next fix or diagnostic step.',
];

export const DEBUG_EXECUTOR_PROMPT_SECTIONS = [
  'For debug tasks, prioritize root cause and evidence over speculative fix list.',
  'If evidence is missing, say exactly what reproduction step, log, or stack detail is needed.',
  'Keep proposed fix or next diagnostic step tightly bounded to observed failure.',
];
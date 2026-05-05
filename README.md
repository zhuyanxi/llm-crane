# LLM Crane

Local-first, developer-first LLM orchestrator.

## Workspace layout

- `apps/vscode-extension`: VS Code entry point and editor-side UX.
- `apps/orchestrator`: local orchestration process.
- `packages/core`: shared runtime config, errors, and utility logic.
- `packages/schemas`: shared Zod schemas and TypeScript contracts.
- `packages/providers`: provider catalog and model resolution helpers.
- `packages/prompts`: prompt assets for early pipeline stages.

## Development commands

Run from repo root:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
```

## Debug paths

- VS Code extension debug: build once, then use workspace launch config `LLM Crane: Extension`.
- Orchestrator debug: run `pnpm --filter @llm-crane/orchestrator build`, then use workspace launch config `LLM Crane: Orchestrator`.
- Run Task flow currently starts local orchestrator over `stdio` and expects `@llm-crane/orchestrator` build output present.
- Current pipeline covers Structurizer plus rules-based Router; router selects configured simple vs complex model path and falls back to complex path if routing output is invalid.

## Configuration

Copy `.env.example` to `.env` and set at least one provider key.

Default model routing config:

- `LLM_CRANE_SIMPLE_MODEL`
- `LLM_CRANE_COMPLEX_MODEL`
- `LLM_CRANE_TRANSPORT`
- `LLM_CRANE_LOG_LEVEL`

Provider keys supported:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`
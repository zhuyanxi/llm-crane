# LLM Crane

Local-first, developer-first LLM orchestrator.

## Workspace layout

- `apps/vscode-extension`: VS Code entry point and editor-side UX.
- `apps/orchestrator`: local orchestration process.
- `packages/core`: shared runtime config, errors, and utility logic.
- `packages/schemas`: shared Zod schemas and TypeScript contracts.
- `packages/providers`: generic model-provider contracts, registry, and HTTP adapters.
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
- Current pipeline runner executes Structurizer -> Router -> Executor as one task transaction and returns unified `taskResult` payload with trace even when executor stage fails.
- Trace payload now includes structured `metadata`, optional `error`, and `retrying` status so extension can explain request intake, routing, executor failures, and retryable provider outcomes.
- Task responses now include cost estimate object with USD pricing from local model catalog; provider token usage yields `exact`, text-length fallback yields `estimated`, and failed or unpriced requests remain `unknown`.
- Current request entry also supports SQLite-backed local response cache keyed by stable task fingerprint; cache hits skip pipeline execution, trace `cache.lookup` and `cache.hit`, and extension can force fresh run with cache bypass.
- Current provider layer uses one registry and one `ModelProvider` contract; OpenAI and DeepSeek share OpenAI-compatible adapter path, Anthropic uses messages API adapter, Gemini uses generateContent adapter.
- Provider failures are normalized into shared error structure and returned in task response instead of crashing protocol flow.

## Configuration

Copy `.env.example` to `.env` and set at least one provider key.

Default model routing config:

- `LLM_CRANE_SIMPLE_MODEL`
- `LLM_CRANE_COMPLEX_MODEL`
- `LLM_CRANE_CACHE_PATH` (optional SQLite file path; default is local app storage path from extension host)
- `LLM_CRANE_TRANSPORT`
- `LLM_CRANE_LOG_LEVEL`

Provider keys supported:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`
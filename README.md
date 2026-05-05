# LLM Crane

Local-first, developer-first LLM orchestrator for VS Code.

LLM Crane runs task requests through local orchestration instead of sending everything straight to one large model. Current V0 gives users visible routing, trace, cost estimate, cache status, and failure diagnostics inside VS Code.

## For Users

### What you get

- Run task from VS Code Command Palette with manual, selection, file, or auto context.
- Route task through Structurizer -> Router -> Executor pipeline.
- See selected model, execution path, token usage, latency, and estimated cost.
- Reuse cached results for repeated tasks, or bypass cache for fresh run.
- See classified diagnostics for configuration, provider, schema, and internal failures.

### Quick start

Prerequisites:

- Node.js `>=22.0.0`
- VS Code `^1.100.0`
- At least one provider API key

Install and build from repo root:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

Create local config:

```bash
cp .env.example .env
```

Set at least one provider key in `.env`, then set default models if you want to override defaults.

Run inside VS Code:

1. Build once so orchestrator output exists.
2. Use workspace launch config `LLM Crane: Extension`.
3. Run command `LLM Crane: Run Task`.
4. Enter task, choose context mode, then press `Run Task` or `Run Without Cache`.

### What result panel shows

- Output text from task execution
- Selected provider/model
- Diagnostic summary when request fails or returns failure state
- Cache hit, miss, or bypassed state
- Execution trace summary
- Token usage, latency, and cost estimate

## Configuration

Copy `.env.example` to `.env` and configure runtime values.

Routing and runtime:

- `LLM_CRANE_SIMPLE_MODEL`: default simple-path model
- `LLM_CRANE_COMPLEX_MODEL`: default complex-path model
- `LLM_CRANE_CACHE_PATH`: optional SQLite file path; default is extension local storage path
- `LLM_CRANE_TRANSPORT`: current V0 transport, `stdio`
- `LLM_CRANE_LOG_LEVEL`: runtime log level

Provider keys:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`

## For Contributors

### Workspace layout

- `apps/vscode-extension`: VS Code command, webview UI, subprocess manager
- `apps/orchestrator`: local orchestration process, pipeline, cache wrapper
- `packages/core`: runtime config, diagnostic helpers, shared errors
- `packages/schemas`: shared Zod schemas and TypeScript contracts
- `packages/providers`: generic provider contracts, registry, HTTP adapters, pricing
- `packages/prompts`: prompt assets for early pipeline stages

### Common commands

Run from repo root:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
```

Common package-scoped examples:

```bash
corepack pnpm --filter @llm-crane/orchestrator test
corepack pnpm --filter @llm-crane/vscode-extension build
corepack pnpm --filter @llm-crane/vscode-extension package:vsix
corepack pnpm --filter @llm-crane/schemas typecheck
```

VSIX packaging writes the distributable file to `apps/vscode-extension/artifacts/llm-crane-<version>.vsix`.

### Debugging

- VS Code extension debug: build once, then use workspace launch config `LLM Crane: Extension`
- Orchestrator debug: run `pnpm --filter @llm-crane/orchestrator build`, then use workspace launch config `LLM Crane: Orchestrator`
- Run Task flow starts local orchestrator over `stdio` and expects `@llm-crane/orchestrator` build output present
- Extension output channel includes readable `[diagnostic]` lines for troubleshooting local failures

### Current V0 behavior

- Router chooses simple vs complex path with rules-based scoring and safe fallback
- Pipeline returns unified `taskResult` payload even when executor stage fails
- Trace events carry `stage`, `status`, `timestamp`, `metadata`, optional `error`, and `retrying` state
- Cost estimates use local USD pricing catalog; status is `exact`, `estimated`, or `unknown`
- Cache uses SQLite-backed local storage with stable task fingerprint and `cache.lookup` / `cache.hit` trace stages
- Diagnostics classify failures into `configuration`, `provider`, `schema`, and `internal`
- Provider layer stays generic through shared `ModelProvider` contract and registry

### Contributor notes

- If you change task payloads or protocol envelopes, update `packages/schemas` first
- If you change pipeline behavior, keep orchestrator trace, cache, cost, and diagnostics in sync
- If you change failure handling, update both `taskResult.diagnostic` and protocol `error.diagnostic` paths
- If you add provider support, prefer extending registry and shared adapter contracts over orchestrator-specific branches
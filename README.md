# LLM Crane

[中文 README](README.zh-CN.md)
[Chinese release checklist and local smoke guide](README.zh-CN.md#发布与安装)

Local-first, developer-first LLM orchestrator for VS Code.

LLM Crane runs task requests through local orchestration instead of sending everything straight to one large model. Current build gives users visible routing, serialized pipeline state, trace, cost estimate, cache status, and failure diagnostics inside VS Code.

## For Users

### What you get

- Run task from VS Code Command Palette with manual, selection, file, or auto context.
- Route task through staged pipeline graphs instead of one opaque model call.
- See selected model, pipeline graph/state, execution path, token usage, latency, and estimated cost.
- Reuse cached results for repeated tasks, or bypass cache for fresh run.
- See classified diagnostics for configuration, provider, schema, and internal failures.

### Quick start

Prerequisites:

- Node.js `>=22.0.0`
- VS Code `^1.100.0`
- At least one hosted provider API key or one configured runtime profile

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

Set at least one hosted provider key or `LLM_CRANE_RUNTIME_PROFILES` in `.env`, then set default models if you want to override defaults.

Run inside VS Code:

1. Build once so orchestrator output exists.
2. Use workspace launch config `LLM Crane: Extension`.
3. Run command `LLM Crane: Run Task`.
4. Enter task, choose context mode, then press `Run Task` or `Run Without Cache`.

### What result panel shows

- Output text from task execution
- Selected provider/model
- Pipeline graph, stage states, and execution path summary
- Diagnostic summary when request fails or returns failure state
- Cache hit, miss, or bypassed state
- Execution trace summary
- Token usage, latency, and cost estimate

## Configuration

Copy `.env.example` to `.env` and configure runtime values.

Routing and runtime:

- `LLM_CRANE_SIMPLE_MODEL`: default simple-path model
- `LLM_CRANE_COMPLEX_MODEL`: default complex-path model
- `LLM_CRANE_RUNTIME_PROFILES`: optional JSON array of runtime descriptors for hosted or local runtimes; each entry declares `runtimeId`, `providerId`, `deploymentMode`, `apiFamily`, `baseUrl`, `models`, and optional auth fields
- `LLM_CRANE_CACHE_PATH`: optional SQLite file path; default is extension local storage path
- `LLM_CRANE_TRANSPORT`: current V0 transport, `stdio`
- `LLM_CRANE_LOG_LEVEL`: runtime log level

Ollama runtime profile example:

```json
[
	{
		"runtimeId": "ollama-local",
		"providerId": "ollama",
		"deploymentMode": "local",
		"apiFamily": "ollama",
		"baseUrl": "http://127.0.0.1:11434",
		"models": ["qwen2.5-coder:7b"],
		"authMode": "none",
		"timeoutMs": 30000
	}
]
```

Minimal manual validation for Ollama:

1. Start local runtime with `ollama serve`.
2. Pull model with `ollama pull qwen2.5-coder:7b`.
3. Set `LLM_CRANE_SIMPLE_MODEL` and `LLM_CRANE_COMPLEX_MODEL` to `qwen2.5-coder:7b`.
4. Set `LLM_CRANE_RUNTIME_PROFILES` to Ollama profile above, then run `LLM Crane: Run Task` in VS Code.

LM Studio / OpenAI-compatible local runtime example:

```json
[
	{
		"runtimeId": "lmstudio-local",
		"providerId": "openai",
		"deploymentMode": "local",
		"apiFamily": "openai-compatible",
		"baseUrl": "http://127.0.0.1:1234/v1",
		"models": ["local-qwen2.5-coder"],
		"authMode": "header",
		"authToken": "lmstudio-secret",
		"authHeaderName": "X-LM-Studio-Key",
		"headers": {
			"X-Client": "llm-crane"
		},
		"timeoutMs": 45000
	}
]
```

Notes for OpenAI-compatible local runtimes:

1. `baseUrl` should include path prefix runtime expects. LM Studio typically uses `http://127.0.0.1:1234/v1`.
2. Use `authMode: none` when runtime does not require auth.
3. Use `authMode: header` plus `authToken` and `authHeaderName` when local proxy or gateway expects custom header.
4. Wrong base URL or wrong local model name surfaces as unified `provider.invalid_request` diagnostic.
5. Result panel and trace now show runtime identity such as `lmstudio-local` or `ollama-local`, not only provider id.

Minimal manual validation for LM Studio:

1. Start LM Studio local server with OpenAI-compatible API enabled.
2. Load target model in LM Studio.
3. Set `LLM_CRANE_SIMPLE_MODEL` and `LLM_CRANE_COMPLEX_MODEL` to model name exposed by LM Studio.
4. Set `LLM_CRANE_RUNTIME_PROFILES` to profile above, then run `LLM Crane: Run Task` in VS Code.

Notes for local runtime observability:

1. Set `LLM_CRANE_SIMPLE_MODEL` and `LLM_CRANE_COMPLEX_MODEL` to model names declared in `LLM_CRANE_RUNTIME_PROFILES`.
2. Result panel shows runtime identity, deployment mode, diagnostic category, and local trace metadata.
3. Local runtime cost defaults to `unknown` in V0 so cloud catalog pricing is not forced onto local execution.

Hosted provider keys:

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
- `taskResult.pipeline` carries serializable stage states, stage contracts, and state transitions for simple and complex graphs
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
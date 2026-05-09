# LLM Crane

[中文 README](README.zh-CN.md)
[Chinese release checklist and local smoke guide](README.zh-CN.md#发布与安装)

Local-first, developer-first LLM orchestrator for VS Code.

LLM Crane runs task requests through local orchestration instead of sending everything straight to one large model. Current build gives users visible routing, serialized pipeline state, trace, cost estimate, cache status, and failure diagnostics inside VS Code.

## For Users

### What you get

- Run task from VS Code Command Palette with freeform, refactor, debug, or architecture-analysis templates plus template-default, selection-first, file-first, or manual-only context strategies.
- Preview template-aware context capture before sending, including selection-first, current-file-first, and manual-only strategies.
- Route task through staged pipeline graphs instead of one opaque model call; complex path now records Planner and conditional Reasoner before Executor.
- Structurizer now consumes template and context metadata, records confidence, and carries expected output hints into downstream stages.
- Result panel now shows pipeline timeline with ordered stages, per-stage status, duration, summary output, and failure highlight.
- Result panel now explains route selection with route reason, routing confidence, early-exit savings, and automatic-versus-manual override status.
- Complex-path verifier stage now runs after Executor, merges low-cost model consistency review with hard rule checks for explicit JSON or list-format requirements, then records structured verdict, findings, and suggested action.
- Verification failures now surface dedicated panel actions so user can retry executor, approve automatic model upgrade with recorded extra cost, or manually confirm current result.
- Retriable provider failures now retry automatically with configurable fixed or exponential backoff, and each scheduled retry is recorded in trace metadata.
- Task panel now lets user keep automatic routing, pin simple or complex default model, or choose one specific configured model.
- Task panel now keeps recent in-session run history so user can reopen old request summaries, trace, cache outcome, rerun markers, and override markers without losing current inputs.
- See selected model, pipeline graph/state, execution path, token usage, latency, and estimated cost.
- Reuse cached results for repeated tasks, or bypass cache for fresh run.
- Resume from checkpointed stages such as Planner, Executor, or Verifier instead of rerunning whole complex pipeline, while keeping latest checkpointed manual override state.
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
4. Choose freeform or a task template, fill required template inputs, preview selected context strategy, optionally pin model selection, then press `Run Task` or `Run Without Cache`.

### What result panel shows

- Output text from task execution
- Context preview before send, with source, priority, and truncation warnings for attached editor contexts
- Validated TaskRequest preview including selected task template and template inputs when present
- Selected provider/model
- Request and response summaries showing automatic routing versus manual model override
- Recent session history cards for comparing old runs by route, model, cache outcome, rerun source, and manual override tag
- Pipeline graph, stage states, and execution path summary
- Pipeline timeline with stage order, status, duration, and per-stage summaries for simple and complex graphs
- Verifier summary with merged model/rule verdict, reasons, findings, suggested next action, and verification action buttons when verifier outcome exists
- Routing summary with route status, confidence, route rationale, selected model/runtime, and early-exit savings when planner or reasoner does not run
- Planner status, ordered steps, and planner trace entries for complex tasks
- Reasoner decision, early-exit cause or escalation summary, and key evidence when complex routing needs extra synthesis
- Execution mode summary showing full run versus stage rerun, plus retained trace history count
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
- `LLM_CRANE_PROVIDER_MAX_RETRIES`: optional max retry count for retriable provider failures; default `2`
- `LLM_CRANE_PROVIDER_BACKOFF_STRATEGY`: optional retry backoff mode, `fixed` or `exponential`; default `exponential`
- `LLM_CRANE_PROVIDER_RETRY_BASE_DELAY_MS`: optional base retry delay in milliseconds; default `500`
- `LLM_CRANE_PROVIDER_RETRY_MAX_DELAY_MS`: optional retry delay cap in milliseconds; default `4000`

Retriable provider categories currently include `rate_limit`, `timeout`, `network`, and `upstream`. Non-retriable errors such as `auth`, `invalid_request`, or `unsupported_model` fail fast and return unified provider diagnostics.

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
- `packages/prompts`: versioned prompt assets for Structurizer and Executor template guidance

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
- Complex path runs Planner, Reasoner, Executor, then Verifier; verifier combines low-cost model review with built-in hard format/schema checks before final response is assembled
- Task panel supports optional template metadata for refactor, debug, and architecture-analysis requests; validated template selection is carried inside `taskTemplate`
- Built-in templates now carry context strategy metadata, and attached contexts can include `priority`, `truncated`, and `originalLength` for preview and downstream prompts
- Structurizer output now carries `expectedOutput` hints plus `confidence`, and serialized structurizer stage state includes template/context metadata for UI and logs
- Prompt assets now live under `packages/prompts/src/v1/*`, with separate Structurizer and Executor guidance for each built-in template
- VS Code task panel now aggregates pipeline state plus stage trace into timeline cards so users can inspect duration, summaries, and failed stage reasons without scanning raw trace only
- VS Code task panel now surfaces router confidence, `routeReason`, override source, and manual model override controls with configured-model validation
- VS Code task panel now surfaces verifier failure reasons, retry or upgrade actions, manual confirmation, and recorded upgrade cost delta inside result history and trace
- VS Code task panel now keeps bounded session history and lets user switch displayed result, request preview, and trace without overwriting composer inputs
- Task response includes checkpoint payload so UI can rerun from stage boundary without recomputing all prior stages
- Stage rerun reuses prior checkpointed outputs before selected stage, preserves prior trace history, keeps checkpointed override state, and marks current response as `full` or `stage-rerun`
- Manual model override now records `policy.override` trace entries and updates selected-provider reasoning in result summaries
- Executor now retries retriable provider failures with configured backoff, records `executor.retry` attempt metadata in trace, and returns unified provider failure once retry budget is exhausted
- Pipeline returns unified `taskResult` payload even when executor stage fails
- `taskResult.pipeline` carries serializable stage states, stage contracts, and state transitions for simple and complex graphs
- `taskResult.plannerResult` carries ordered steps, decision points, open questions, and downstream hints for complex tasks
- `taskResult.reasonerResult` carries `needReasoning`, decision source, early-exit or escalation summary, and key evidence for downstream executor/UI use
- `taskResult.verifierResult` now carries shared verification verdict, reasons, suggested action, and merged findings from model verifier plus built-in rule verifiers, with finding source metadata for downstream UI or trace use
- `taskResult.checkpoint` carries resumable task request, executor output, provider result, pipeline state, and trace history for stage rerun API
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
# LLM Crane

[English README](README.md)

面向 VS Code 的本地优先、开发者优先 LLM 编排器。

LLM Crane 会先在本地完成任务编排，而不是把所有请求直接发给单一大模型。当前 V0 已经在 VS Code 内提供可见的路由、trace、成本估算、缓存状态和失败诊断。

## 面向用户

### 你能获得什么

- 从 VS Code Command Palette 发起任务，支持 manual、selection、file、auto 四种上下文模式。
- 通过 Structurizer -> Router -> Executor 流水线对任务进行路由。
- 查看选中的模型、执行路径、token 使用量、延迟和成本估算。
- 对重复任务复用缓存结果，或绕过缓存执行全新运行。
- 查看 configuration、provider、schema、internal 四类失败诊断。

### 快速开始

前置要求：

- Node.js `>=22.0.0`
- VS Code `^1.100.0`
- 至少配置一个 hosted provider API key，或至少配置一个 runtime profile

在仓库根目录安装并构建：

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

创建本地配置：

```bash
cp .env.example .env
```

在 `.env` 中至少配置一个 hosted provider key，或者配置 `LLM_CRANE_RUNTIME_PROFILES`。如果你想覆盖默认模型，也可以同时设置默认模型。

在 VS Code 内运行：

1. 先构建一次，确保 orchestrator 输出文件已经存在。
2. 使用工作区 launch config `LLM Crane: Extension`。
3. 运行命令 `LLM Crane: Run Task`。
4. 输入任务，选择上下文模式，然后点击 `Run Task` 或 `Run Without Cache`。

### 结果面板会显示什么

- 任务执行输出文本
- 选中的 provider/model
- 请求失败或返回失败状态时的诊断摘要
- cache hit、miss 或 bypassed 状态
- 执行 trace 摘要
- token 使用量、延迟和成本估算

## 配置

将 `.env.example` 复制为 `.env`，然后配置运行时参数。

路由和运行时：

- `LLM_CRANE_SIMPLE_MODEL`：默认 simple 路径模型
- `LLM_CRANE_COMPLEX_MODEL`：默认 complex 路径模型
- `LLM_CRANE_RUNTIME_PROFILES`：可选 JSON 数组，用于声明 hosted 或 local runtime descriptor；每项包含 `runtimeId`、`providerId`、`deploymentMode`、`apiFamily`、`baseUrl`、`models` 以及可选鉴权字段
- `LLM_CRANE_CACHE_PATH`：可选 SQLite 文件路径；默认使用插件本地存储路径
- `LLM_CRANE_TRANSPORT`：当前 V0 transport，固定为 `stdio`
- `LLM_CRANE_LOG_LEVEL`：运行时日志级别

Ollama runtime profile 示例：

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

Ollama 最小人工验证步骤：

1. 用 `ollama serve` 启动本地 runtime。
2. 用 `ollama pull qwen2.5-coder:7b` 拉取模型。
3. 将 `LLM_CRANE_SIMPLE_MODEL` 和 `LLM_CRANE_COMPLEX_MODEL` 设为 `qwen2.5-coder:7b`。
4. 将 `LLM_CRANE_RUNTIME_PROFILES` 设为上面的 Ollama profile，然后在 VS Code 中运行 `LLM Crane: Run Task`。

LM Studio / OpenAI-compatible 本地 runtime 示例：

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

OpenAI-compatible 本地 runtime 说明：

1. `baseUrl` 需要包含 runtime 实际要求的路径前缀。LM Studio 通常使用 `http://127.0.0.1:1234/v1`。
2. 如果 runtime 不需要鉴权，使用 `authMode: none`。
3. 如果本地 proxy 或 gateway 需要自定义 header，使用 `authMode: header`，并同时提供 `authToken` 和 `authHeaderName`。
4. 错误的 base URL 或错误的本地模型名会统一映射为 `provider.invalid_request` 诊断。
5. 结果面板和 trace 现在会显示 `lmstudio-local` 或 `ollama-local` 这类 runtime identity，而不只是 provider id。

LM Studio 最小人工验证步骤：

1. 启动 LM Studio 本地服务，并开启 OpenAI-compatible API。
2. 在 LM Studio 中加载目标模型。
3. 将 `LLM_CRANE_SIMPLE_MODEL` 和 `LLM_CRANE_COMPLEX_MODEL` 设为 LM Studio 暴露出来的模型名。
4. 将 `LLM_CRANE_RUNTIME_PROFILES` 设为上面的 profile，然后在 VS Code 中运行 `LLM Crane: Run Task`。

本地 runtime 可观测性说明：

1. 将 `LLM_CRANE_SIMPLE_MODEL` 和 `LLM_CRANE_COMPLEX_MODEL` 设为 `LLM_CRANE_RUNTIME_PROFILES` 中声明的模型名。
2. 结果面板会显示 runtime identity、deployment mode、diagnostic category 和本地 trace metadata。
3. V0 中本地 runtime 成本默认显示为 `unknown`，不会强行套用云端价格目录。

Hosted provider keys：

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`

## 面向贡献者

### 工作区结构

- `apps/vscode-extension`：VS Code 命令、webview UI、subprocess manager
- `apps/orchestrator`：本地编排进程、pipeline、cache wrapper
- `packages/core`：runtime config、diagnostic helper、共享错误定义
- `packages/schemas`：共享 Zod schema 和 TypeScript 合约
- `packages/providers`：通用 provider contract、registry、HTTP adapter、pricing
- `packages/prompts`：早期流水线阶段使用的 prompt 资源

### 常用命令

在仓库根目录运行：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
```

常见的 package 级命令示例：

```bash
corepack pnpm --filter @llm-crane/orchestrator test
corepack pnpm --filter @llm-crane/vscode-extension build
corepack pnpm --filter @llm-crane/vscode-extension package:vsix
corepack pnpm --filter @llm-crane/schemas typecheck
```

VSIX 打包结果会输出到 `apps/vscode-extension/artifacts/llm-crane-<version>.vsix`。

### 调试

- VS Code extension 调试：先构建一次，然后使用工作区 launch config `LLM Crane: Extension`
- Orchestrator 调试：运行 `pnpm --filter @llm-crane/orchestrator build`，然后使用工作区 launch config `LLM Crane: Orchestrator`
- Run Task 流程会通过 `stdio` 启动本地 orchestrator，并要求 `@llm-crane/orchestrator` 的构建产物已经存在
- Extension output channel 会输出可读的 `[diagnostic]` 日志，便于排查本地失败问题

### 当前 V0 行为

- Router 通过规则打分和安全兜底在 simple 与 complex 路径之间做选择
- 即使 executor 阶段失败，pipeline 也会返回统一的 `taskResult` payload
- Trace event 包含 `stage`、`status`、`timestamp`、`metadata`，以及可选 `error` 和 `retrying` 状态
- 成本估算使用本地 USD 价格目录；状态可能为 `exact`、`estimated` 或 `unknown`
- Cache 使用 SQLite 本地存储，带稳定任务指纹和 `cache.lookup` / `cache.hit` trace 阶段
- Diagnostics 将失败划分为 `configuration`、`provider`、`schema`、`internal`
- Provider 层通过共享 `ModelProvider` contract 和 registry 保持通用抽象

### 贡献说明

- 如果你修改 task payload 或 protocol envelope，先更新 `packages/schemas`
- 如果你修改 pipeline 行为，保持 orchestrator trace、cache、cost 和 diagnostics 同步
- 如果你修改失败处理，同时更新 `taskResult.diagnostic` 和协议 `error.diagnostic` 两条路径
- 如果你增加 provider 支持，优先扩展 registry 和共享 adapter contract，而不是引入 orchestrator 特判分支
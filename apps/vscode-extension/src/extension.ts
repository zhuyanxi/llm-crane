import * as vscode from 'vscode';
import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';

const RUN_TASK_COMMAND = 'llmCrane.runTask';
const TASK_PANEL_VIEW_TYPE = 'llmCrane.taskPanel';

type TaskPanelInboundMessage = {
  type: 'submitTask';
  value: string;
};

type TaskPanelStatus = 'idle' | 'running' | 'success' | 'error';

type TaskPanelStatusMessage = {
  type: 'taskStatus';
  status: TaskPanelStatus;
  headline: string;
  detail: string;
  submittedTask?: string;
};

export function activate(context: vscode.ExtensionContext): void {
  let taskPanel: vscode.WebviewPanel | undefined;

  const disposable = vscode.commands.registerCommand(RUN_TASK_COMMAND, async () => {
    if (taskPanel) {
      taskPanel.reveal(vscode.ViewColumn.Beside, true);
      postTaskStatus(taskPanel.webview, {
        status: 'idle',
        headline: 'Task panel ready',
        detail:
          'Describe task, then press Run Task. V0-S05 validates input and runtime config before full orchestrator wiring.',
      });
      return;
    }

    const panel = createTaskPanel();
    taskPanel = panel;

    panel.webview.html = getTaskPanelHtml(panel.webview);
    postTaskStatus(panel.webview, {
      status: 'idle',
      headline: 'Task panel ready',
      detail: 'Describe task, then press Run Task. V0-S05 validates input and runtime config before full orchestrator wiring.',
    });

    const panelDisposables: vscode.Disposable[] = [];

    panel.onDidDispose(
      () => {
        taskPanel = undefined;
        for (const disposable of panelDisposables) {
          disposable.dispose();
        }
      },
      undefined,
      panelDisposables,
    );

    panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        await handleTaskPanelMessage(panel.webview, message);
      },
      undefined,
      panelDisposables,
    );
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}

function createTaskPanel(): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(TASK_PANEL_VIEW_TYPE, 'LLM Crane Task', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
}

async function handleTaskPanelMessage(webview: vscode.Webview, message: unknown): Promise<void> {
  if (!isTaskPanelInboundMessage(message)) {
    return;
  }

  const taskText = message.value.trim();
  if (!taskText) {
    postTaskStatus(webview, {
      status: 'error',
      headline: 'Task description required',
      detail: 'Enter task text before submitting.',
    });
    return;
  }

  postTaskStatus(webview, {
    status: 'running',
    headline: 'Submitting task',
    detail: 'Validating runtime config and capturing task metadata for orchestrator handoff.',
    submittedTask: taskText,
  });

  try {
    const config = loadRuntimeConfig(process.env);

    postTaskStatus(webview, {
      status: 'success',
      headline: 'Task captured',
      detail: `Simple model: ${config.defaultSimpleModel}. Complex model: ${config.defaultComplexModel}. Full orchestrator submission lands in V0-S07.`,
      submittedTask: taskText,
    });
  } catch (error) {
    const detail = error instanceof ConfigurationError ? error.message : 'Unexpected LLM Crane error.';

    postTaskStatus(webview, {
      status: 'error',
      headline: 'Submission blocked',
      detail,
      submittedTask: taskText,
    });
  }
}

function isTaskPanelInboundMessage(message: unknown): message is TaskPanelInboundMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<TaskPanelInboundMessage>;
  return candidate.type === 'submitTask' && typeof candidate.value === 'string';
}

function postTaskStatus(webview: vscode.Webview, message: Omit<TaskPanelStatusMessage, 'type'>): void {
  void webview.postMessage({
    type: 'taskStatus',
    ...message,
  });
}

function getTaskPanelHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <title>LLM Crane Task</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 20px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }

      .shell {
        display: grid;
        gap: 16px;
      }

      .eyebrow {
        margin: 0 0 4px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 12px;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      .intro {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      label {
        font-weight: 600;
      }

      textarea {
        width: 100%;
        min-height: 180px;
        resize: vertical;
        padding: 12px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 6px;
        font: inherit;
        line-height: 1.5;
      }

      textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      button {
        border: none;
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        font-weight: 600;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        cursor: pointer;
      }

      button:hover {
        background: var(--vscode-button-hoverBackground);
      }

      .status-panel {
        display: grid;
        gap: 8px;
        padding: 14px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-panel-border));
      }

      .status-row {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .status-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 78px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }

      .status-idle .status-badge {
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
      }

      .status-running .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconQueued);
      }

      .status-success .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconPassed);
      }

      .status-error .status-badge {
        color: var(--vscode-editor-background);
        background: var(--vscode-testing-iconFailed);
      }

      .status-detail {
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      .submitted-task {
        margin: 0;
        padding: 12px;
        border-radius: 8px;
        background: var(--vscode-textCodeBlock-background);
        color: var(--vscode-textPreformat-foreground);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .usage {
        display: grid;
        gap: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      ol {
        margin: 0;
        padding-left: 18px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <p class="eyebrow">V0-S05</p>
        <h1>LLM Crane Run Task</h1>
        <p class="intro">
          Use Command Palette entry to open panel, describe task, then submit from inside VS Code. Current step covers command,
          panel, status transitions, basic runtime validation.
        </p>
      </header>

      <section class="composer">
        <label for="task-input">Task description</label>
        <textarea id="task-input" placeholder="Example: Review current file, explain bug risk, propose small refactor."></textarea>
      </section>

      <div class="actions">
        <button id="run-task" type="button">Run Task</button>
        <span class="hint">Shortcut: Cmd/Ctrl + Enter</span>
      </div>

      <section class="status-panel status-idle" id="status-panel" aria-live="polite">
        <div class="status-row">
          <span class="status-badge" id="status-badge">Idle</span>
          <strong id="status-headline">Task panel ready</strong>
        </div>
        <p class="status-detail" id="status-detail">Describe task and press Run Task.</p>
        <pre class="submitted-task" id="submitted-task" hidden></pre>
      </section>

      <section class="usage">
        <h2>How to use</h2>
        <ol>
          <li>Run <strong>LLM Crane: Run Task</strong> from Command Palette.</li>
          <li>Describe coding task in text area.</li>
          <li>Press <strong>Run Task</strong> and inspect running, success, or failure status.</li>
        </ol>
      </section>
    </main>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const statusLabels = {
        idle: 'Idle',
        running: 'Running',
        success: 'Success',
        error: 'Failed',
      };

      const taskInput = document.getElementById('task-input');
      const runTaskButton = document.getElementById('run-task');
      const statusPanel = document.getElementById('status-panel');
      const statusBadge = document.getElementById('status-badge');
      const statusHeadline = document.getElementById('status-headline');
      const statusDetail = document.getElementById('status-detail');
      const submittedTask = document.getElementById('submitted-task');

      function setStatus(status, headline, detail, taskText) {
        statusPanel.className = 'status-panel status-' + status;
        statusBadge.textContent = statusLabels[status] ?? 'Idle';
        statusHeadline.textContent = headline;
        statusDetail.textContent = detail;

        if (taskText && taskText.trim()) {
          submittedTask.hidden = false;
          submittedTask.textContent = taskText;
        } else {
          submittedTask.hidden = true;
          submittedTask.textContent = '';
        }
      }

      function submitTask() {
        const value = taskInput.value;
        setStatus('running', 'Submitting task', 'Sending task to extension host.', value);
        vscode.postMessage({ type: 'submitTask', value });
      }

      runTaskButton.addEventListener('click', submitTask);
      taskInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          submitTask();
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type !== 'taskStatus') {
          return;
        }

        setStatus(message.status, message.headline, message.detail, message.submittedTask);
      });
    </script>
  </body>
</html>`;
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}
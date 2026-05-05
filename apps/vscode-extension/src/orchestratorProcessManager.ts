import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import {
  ConfigurationError,
  LLMCraneDiagnosticError,
  SubprocessNotRunningError,
  createDiagnosticError,
  formatDiagnosticLog,
  loadRuntimeConfig,
} from '@llm-crane/core';
import {
  OrchestratorEventSchema,
  OrchestratorRequestSchema,
  TaskResponseSchema,
  type OrchestratorEvent,
  type OrchestratorRequest,
  type TaskRequest,
  type TaskResponse,
} from '@llm-crane/schemas';

export type OrchestratorReadyMode = 'started' | 'reused';

export type OrchestratorDispatchResult = {
  response: TaskResponse;
  readyMode: OrchestratorReadyMode;
  processId: number | undefined;
};

type CorrelatedOrchestratorEvent = Extract<OrchestratorEvent, { id: string }>;

type PendingProtocolRequest = {
  expectedType: 'healthResult' | 'taskResult';
  resolve: (event: CorrelatedOrchestratorEvent) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type OutboundOrchestratorRequest =
  | Omit<Extract<OrchestratorRequest, { type: 'health' }>, 'id'>
  | Omit<Extract<OrchestratorRequest, { type: 'runTask' }>, 'id'>;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toErrorMessage(error: unknown): string {
  return toError(error).message;
}

function formatDiagnosticToast(error: LLMCraneDiagnosticError): string {
  return `${error.diagnostic.summary}: ${error.diagnostic.message}`;
}

export class OrchestratorProcessManager {
  private readonly outputChannel = vscode.window.createOutputChannel('LLM Crane');
  private orchestratorProcess: childProcess.ChildProcessWithoutNullStreams | undefined;
  private stdoutReader: readline.Interface | undefined;
  private readonly pendingRequests = new Map<string, PendingProtocolRequest>();
  private startPromise: Promise<OrchestratorReadyMode> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private expectedStop = false;
  private disposed = false;
  private requestCounter = 0;

  constructor(
    private readonly extensionRootPath: string,
    private readonly storageRootPath: string,
  ) {}

  async runTask(taskRequest: TaskRequest): Promise<OrchestratorDispatchResult> {
    const readyMode = await this.ensureReady();
    const event = await this.sendRequest({ type: 'runTask', request: taskRequest }, 'taskResult', 45000);
    if (event.type !== 'taskResult') {
      throw new Error(`Expected taskResult, received ${event.type}.`);
    }

    return {
      response: TaskResponseSchema.parse(event.response),
      readyMode,
      processId: this.orchestratorProcess?.pid,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.stopProcess();
    this.outputChannel.dispose();
  }

  private async ensureReady(): Promise<OrchestratorReadyMode> {
    if (this.isProcessRunning()) {
      try {
        await this.sendHealthCheck();
        this.outputChannel.appendLine('[process] reusing running orchestrator process');
        return 'reused';
      } catch (error) {
        this.outputChannel.appendLine(`[process] health check failed, restarting orchestrator: ${toErrorMessage(error)}`);
        await this.stopProcess();
      }
    }

    if (this.startPromise) {
      await this.startPromise;
      return 'reused';
    }

    this.startPromise = this.startProcess();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startProcess(): Promise<OrchestratorReadyMode> {
    try {
      const config = loadRuntimeConfig(process.env);
      if (config.transport !== 'stdio') {
        throw new ConfigurationError('IPC transport not yet supported in V0-S07. Set LLM_CRANE_TRANSPORT=stdio.');
      }

      const orchestratorEntryPath = this.getOrchestratorEntryPath();
      if (!fs.existsSync(orchestratorEntryPath)) {
        throw new Error(
          `Orchestrator entry missing at ${orchestratorEntryPath}. Run extension VSIX packaging bundle or corepack pnpm --filter @llm-crane/orchestrator build for repo development.`,
        );
      }

      const readyPromise = this.createReadyPromise(5000);
      const orchestratorProcess = childProcess.spawn(process.execPath, [orchestratorEntryPath], {
        cwd: this.getOrchestratorWorkingDirectory(orchestratorEntryPath),
        env: {
          ...process.env,
          LLM_CRANE_CACHE_PATH: this.getCacheDatabasePath(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.expectedStop = false;
      this.orchestratorProcess = orchestratorProcess;
      this.attachProcess(orchestratorProcess);
      this.outputChannel.appendLine(`[process] spawned orchestrator pid=${orchestratorProcess.pid ?? 'unknown'} transport=stdio`);

      await readyPromise;
      await this.sendHealthCheck();
      return 'started';
    } catch (error) {
      const diagnosticError = createDiagnosticError(error, {
        category: 'internal',
        code: 'internal.orchestrator_start_failed',
        summary: 'Local orchestrator unavailable',
        message: 'LLM Crane could not start local orchestrator.',
        stage: 'extension.startProcess',
      });

      this.outputChannel.appendLine(`[diagnostic] ${formatDiagnosticLog(diagnosticError.diagnostic)}`);
      throw diagnosticError;
    }
  }

  private attachProcess(orchestratorProcess: childProcess.ChildProcessWithoutNullStreams): void {
    this.stdoutReader?.close();
    this.stdoutReader = readline.createInterface({
      input: orchestratorProcess.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on('line', (line) => {
      this.handleProtocolLine(line);
    });

    orchestratorProcess.stderr.on('data', (chunk: Buffer | string) => {
      this.outputChannel.append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    orchestratorProcess.on('error', (error) => {
      const diagnosticError = createDiagnosticError(error, {
        category: 'internal',
        code: 'internal.subprocess_error',
        summary: 'Local orchestrator process failed',
        message: 'Local orchestrator process raised runtime error.',
        stage: 'extension.subprocess',
      });

      this.outputChannel.appendLine(`[process] orchestrator error: ${diagnosticError.message}`);
      this.outputChannel.appendLine(`[diagnostic] ${formatDiagnosticLog(diagnosticError.diagnostic)}`);
      this.rejectReadyIfPending(diagnosticError);
      this.rejectAllPending(diagnosticError);
    });

    orchestratorProcess.on('exit', (code, signal) => {
      const exitMessage = `orchestrator exited code=${code ?? 'null'} signal=${signal ?? 'none'}`;
      const unexpected = !this.expectedStop;

      this.outputChannel.appendLine(`[process] ${exitMessage}`);
      this.cleanupProcessState();

      const exitError = createDiagnosticError(new Error(exitMessage), {
        category: 'internal',
        code: unexpected ? 'internal.subprocess_exit' : 'internal.subprocess_stopped',
        summary: unexpected ? 'Local orchestrator exited unexpectedly' : 'Local orchestrator stopped',
        message: unexpected
          ? `Orchestrator exited unexpectedly (${exitMessage}).`
          : `Orchestrator stopped (${exitMessage}).`,
        stage: 'extension.subprocess',
      });

      this.outputChannel.appendLine(`[diagnostic] ${formatDiagnosticLog(exitError.diagnostic)}`);

      this.rejectReadyIfPending(exitError);
      this.rejectAllPending(exitError);

      if (unexpected && !this.disposed) {
        void vscode.window.showWarningMessage('LLM Crane orchestrator exited unexpectedly. Next task will restart it.');
      }
    });
  }

  private getCacheDatabasePath(): string {
    const cacheDirectory = path.join(this.storageRootPath, 'cache');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    return path.join(cacheDirectory, 'task-cache.sqlite');
  }

  private getOrchestratorWorkingDirectory(orchestratorEntryPath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return workspaceRoot ?? path.dirname(orchestratorEntryPath);
  }

  private handleProtocolLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.outputChannel.appendLine(`[stdout] ${trimmed}`);

    let event: OrchestratorEvent;
    try {
      event = OrchestratorEventSchema.parse(JSON.parse(trimmed));
    } catch (error) {
      this.outputChannel.appendLine(`[protocol] ignored non-protocol stdout: ${toErrorMessage(error)}`);
      return;
    }

    switch (event.type) {
      case 'ready':
        this.resolveReadyIfPending();
        return;
      case 'error': {
        const diagnosticError = event.diagnostic
          ? new LLMCraneDiagnosticError(event.diagnostic)
          : createDiagnosticError(new Error(event.message), {
              category: 'internal',
              code: 'internal.protocol_error',
              summary: 'Local orchestrator error',
              message: event.message,
              stage: 'extension.protocol',
            });

        this.outputChannel.appendLine(`[diagnostic] ${formatDiagnosticLog(diagnosticError.diagnostic)}`);
        if (event.id) {
          this.rejectPendingRequest(event.id, diagnosticError);
          return;
        }

        this.rejectReadyIfPending(diagnosticError);
        void vscode.window.showErrorMessage(formatDiagnosticToast(diagnosticError));
        return;
      }
      case 'healthResult':
      case 'taskResult':
        this.resolvePendingRequest(event);
    }
  }

  private async sendHealthCheck(): Promise<void> {
    const event = await this.sendRequest({ type: 'health' }, 'healthResult', 3000);
    if (event.type !== 'healthResult') {
      throw new Error(`Expected healthResult, received ${event.type}.`);
    }
  }

  private async sendRequest(
    requestPayload: OutboundOrchestratorRequest,
    expectedType: PendingProtocolRequest['expectedType'],
    timeoutMs: number,
  ): Promise<CorrelatedOrchestratorEvent> {
    const orchestratorProcess = this.orchestratorProcess;
    if (!orchestratorProcess?.stdin.writable) {
      throw createDiagnosticError(new SubprocessNotRunningError('LLM Crane orchestrator'), {
        category: 'internal',
        code: 'internal.subprocess_not_running',
        summary: 'Local orchestrator unavailable',
        message: 'LLM Crane orchestrator process is not running.',
        stage: 'extension.protocol',
      });
    }

    const id = `req-${++this.requestCounter}`;
    const request = OrchestratorRequestSchema.parse({
      id,
      ...requestPayload,
    });

    const serialized = JSON.stringify(request);
    this.outputChannel.appendLine(`[stdin] ${serialized}`);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          createDiagnosticError(new Error(`Timed out waiting for ${expectedType} from orchestrator.`), {
            category: 'internal',
            code: 'internal.orchestrator_timeout',
            summary: 'Local orchestrator timed out',
            message: `Timed out waiting for ${expectedType} from orchestrator.`,
            stage: 'extension.protocol',
            retriable: true,
          }),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, {
        expectedType,
        resolve,
        reject,
        timeout,
      });

      orchestratorProcess.stdin.write(`${serialized}\n`, 'utf8', (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(
          createDiagnosticError(error, {
            category: 'internal',
            code: 'internal.protocol_write_failed',
            summary: 'Failed to send request to local orchestrator',
            message: 'Extension could not send request to local orchestrator.',
            stage: 'extension.protocol',
          }),
        );
      });
    });
  }

  private resolvePendingRequest(event: CorrelatedOrchestratorEvent): void {
    const pendingRequest = this.pendingRequests.get(event.id);
    if (!pendingRequest) {
      this.outputChannel.appendLine(`[protocol] no pending request for ${event.id}`);
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(event.id);

    if (pendingRequest.expectedType !== event.type) {
      pendingRequest.reject(
        new Error(`Expected ${pendingRequest.expectedType} for ${event.id}, received ${event.type} instead.`),
      );
      return;
    }

    pendingRequest.resolve(event);
  }

  private rejectPendingRequest(id: string, error: Error): void {
    const pendingRequest = this.pendingRequests.get(id);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(id);
    pendingRequest.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pendingRequest] of this.pendingRequests.entries()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private createReadyPromise(timeoutMs: number): Promise<void> {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
    }

    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.readyTimer = undefined;
        reject(new Error(`Timed out waiting ${timeoutMs}ms for orchestrator ready signal.`));
      }, timeoutMs);
    });
  }

  private getOrchestratorEntryPath(): string {
    const packagedEntryPath = path.resolve(this.extensionRootPath, 'dist/orchestrator.js');
    if (fs.existsSync(packagedEntryPath)) {
      return packagedEntryPath;
    }

    return path.resolve(this.extensionRootPath, '../orchestrator/dist/index.js');
  }

  private isProcessRunning(): boolean {
    return Boolean(this.orchestratorProcess && this.orchestratorProcess.exitCode === null && !this.orchestratorProcess.killed);
  }

  private resolveReadyIfPending(): void {
    if (!this.readyResolve) {
      return;
    }

    this.readyResolve();
    this.clearReadyState();
  }

  private rejectReadyIfPending(error: Error): void {
    if (!this.readyReject) {
      return;
    }

    this.readyReject(error);
    this.clearReadyState();
  }

  private clearReadyState(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }

    this.readyResolve = undefined;
    this.readyReject = undefined;
  }

  private async stopProcess(): Promise<void> {
    const orchestratorProcess = this.orchestratorProcess;
    if (!orchestratorProcess) {
      return;
    }

    this.expectedStop = true;

    if (orchestratorProcess.exitCode !== null || orchestratorProcess.killed) {
      this.cleanupProcessState();
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 1500);

      orchestratorProcess.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      orchestratorProcess.kill();
    });

    this.cleanupProcessState();
  }

  private cleanupProcessState(): void {
    if (this.stdoutReader) {
      this.stdoutReader.close();
      this.stdoutReader = undefined;
    }

    this.orchestratorProcess = undefined;
    this.clearReadyState();
  }
}
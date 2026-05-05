import * as vscode from 'vscode';
import { ConfigurationError, loadRuntimeConfig } from '@llm-crane/core';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('llmCrane.runTask', async () => {
    try {
      const config = loadRuntimeConfig(process.env);

      await vscode.window.showInformationMessage(
        `LLM Crane ready. Simple model: ${config.defaultSimpleModel}. Complex model: ${config.defaultComplexModel}.`,
      );
    } catch (error) {
      const message = error instanceof ConfigurationError ? error.message : 'Unexpected LLM Crane error.';
      await vscode.window.showErrorMessage(message);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
import * as vscode from 'vscode';

// Singleton OutputChannel for the entire extension
export const outputChannel = vscode.window.createOutputChannel('CodeTorch');

/**
 * Write a message to the CodeTorch output channel.
 * Accepts any set of arguments similar to console.log.
 */
export function log(...args: unknown[]): void {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  outputChannel.appendLine(text);
} 
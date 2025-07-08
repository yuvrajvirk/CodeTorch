import * as vscode from 'vscode';
import * as crypto from 'crypto';

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

/**
 * Compute a short SHA-1 hash for a given string. Useful for content-based caching.
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
} 
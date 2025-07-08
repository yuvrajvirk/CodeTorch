import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FunctionSummary } from './llm';
import { log } from './utils';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

function cacheDir(): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;
  const dir = path.join(root, '.codetorch');
  ensureDir(dir);
  return dir;
}

export function cacheFilePath(document: vscode.TextDocument): string | undefined {
  const dir = cacheDir();
  if (!dir) return undefined;
  // create human-readable filename with safe characters
  const rel = vscode.workspace.asRelativePath(document.uri);
  const safe = rel
    .replace(/[<>:"|?*\\/]/g, '_') // replace invalid chars with underscore
    .replace(/\s+/g, '_') // replace spaces with underscore
    .replace(/\.+/g, '.') // collapse multiple dots
    .replace(/^\.+|\.+$/g, '') // remove leading/trailing dots
    .replace(/_+/g, '_') // collapse multiple underscores
    .replace(/^_+|_+$/g, ''); // remove leading/trailing underscores
  return path.join(dir, `${safe}.summary.json`);
}

export async function loadSummary(document: vscode.TextDocument): Promise<FunctionSummary[] | null> {
  const file = cacheFilePath(document);
  log('loadSummary', file);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as FunctionSummary[];
  } catch {
    // ignore
  }
  return null;
}

export async function saveSummary(document: vscode.TextDocument, data: FunctionSummary[]): Promise<void> {
  const file = cacheFilePath(document);
  if (!file) return;
  try {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

// === CALL GRAPH STORAGE ===

export function callGraphFilePath(document: vscode.TextDocument): string | undefined {
  const dir = cacheDir();
  if (!dir) return undefined;
  // create human-readable filename with safe characters
  const rel = vscode.workspace.asRelativePath(document.uri);
  const safe = rel
    .replace(/[<>:"|?*\\/]/g, '_') // replace invalid chars with underscore
    .replace(/\s+/g, '_') // replace spaces with underscore
    .replace(/\.+/g, '.') // collapse multiple dots
    .replace(/^\.+|\.+$/g, '') // remove leading/trailing dots
    .replace(/_+/g, '_') // collapse multiple underscores
    .replace(/^_+|_+$/g, ''); // remove leading/trailing underscores
  return path.join(dir, `${safe}.callgraph.json`);
}

export async function loadCallGraph<T = unknown>(document: vscode.TextDocument): Promise<T | null> {
  const file = callGraphFilePath(document);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed as T;
  } catch {
    // ignore
  }
  return null;
}

export async function saveCallGraph(document: vscode.TextDocument, data: unknown): Promise<void> {
  const file = callGraphFilePath(document);
  if (!file) return;
  try {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

/**
 * Update cached line numbers based on text changes.
 * This implements the "live-shift" approach to keep comments in sync with line changes.
 * 
 * @param document The document that changed
 * @param changes Array of text document content changes
 * @returns Updated SemanticUnitComment array with corrected line numbers
 */
export async function updateCachedLineNumbers(
  document: vscode.TextDocument, 
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): Promise<FunctionSummary[] | null> {
  // Line-shift tracking is obsolete in the code-content model.
  // We now regenerate summaries based on code equality, so we simply return existing cache.
  return await loadSummary(document);
} 
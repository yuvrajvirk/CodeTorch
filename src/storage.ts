import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SemanticUnitComment } from './llm';

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
  // encode relative path as base64 to avoid FS issues
  const rel = vscode.workspace.asRelativePath(document.uri);
  const safe = Buffer.from(rel).toString('base64').replace(/=+$/,'');
  return path.join(dir, `${safe}.summary.json`);
}

export async function loadSummary(document: vscode.TextDocument): Promise<SemanticUnitComment[] | null> {
  const file = cacheFilePath(document);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as SemanticUnitComment[];
  } catch {
    // ignore
  }
  return null;
}

export async function saveSummary(document: vscode.TextDocument, data: SemanticUnitComment[]): Promise<void> {
  const file = cacheFilePath(document);
  if (!file) return;
  try {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
} 
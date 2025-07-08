import * as vscode from 'vscode';
import { detectFunctions } from './parser';
import { summarizeFunctionSemanticUnits, ChunkSummary, FunctionSummary } from './llm';
import { log } from './utils';
import { loadSummary, saveSummary } from './storage';

/**
 * FunctionSummaryCodeLensProvider
 * --------------------------------
 * This provider adds *inline* explanatory comments for every function in the active
 * document by leveraging VS Code's CodeLens API.
 *
 * Flow:
 * 1. `provideCodeLenses()` is invoked by VS Code whenever CodeLens data is needed.
 * 2. We detect all functions in the file via `detectFunctions()`.
 * 3. For each function we send its source to `summarizeFunctionSemanticUnits()` which
 *    returns a list of objects: `{ line, summary }`.
 *    – `line` is **1-based** relative to the first line of that function.
 *    – `summary` is a human-readable description of the semantic unit.
 * 4. We convert each `{ line, summary }` into a CodeLens placed **immediately before**
 *    the referenced source line (clamped to the function body).
 * 5. The CodeLens `title` shows the summary; it's bound to a no-op command so it renders
 *    as plain text without an underline.
 *
 * Caching: results are memoised per document URI to avoid repeat LLM calls while
 * editing. The cache is cleared whenever the document text changes.
 */

export class FunctionSummaryCodeLensProvider implements vscode.CodeLensProvider {
  private cache = new Map<string, vscode.CodeLens[]>(); // key: document URI
  private updateTimeout = new Map<string, NodeJS.Timeout>(); // key: document URI

  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    // Skip certain file types that shouldn't be analyzed
    const uri = document.uri.toString();
    log('uri', uri);
    log('document.fileName', document.fileName);
    if (uri.includes('extension-output') || 
        uri.includes('extension-log') ||
        uri.includes('.git') ||
        uri.includes('node_modules') ||
        uri.includes('.codetorch')) {
      return [];
    }

    log('provideCodeLenses start', uri);
    const cached = this.cache.get(uri);
    if (cached) {
      log('Using cached CodeLens', cached.length);
      return cached;
    }

    const functions = await detectFunctions(document);
    const cachedSummaries = await loadSummary(document) ?? [];
    const updatedSummaries: FunctionSummary[] = [...cachedSummaries];
    const matched = new Set<FunctionSummary>();
    let summariesChanged = false;

    const lenses: vscode.CodeLens[] = [];

    // Compute end lines for each function
    const sorted = [...functions].sort((a, b) => a.startLine - b.startLine);
    for (let i = 0; i < sorted.length; i++) {
      const fn = sorted[i];
      const nextStart = (i + 1 < sorted.length) ? sorted[i + 1].startLine : document.lineCount;
      const code = document.getText(new vscode.Range(fn.startLine, 0, nextStart, 0));

      let fnSummary: FunctionSummary | undefined = cachedSummaries.find(s => s.liveCode === code);
      
      if (!fnSummary || (!document.isDirty && fnSummary.lastSavedCode !== code)) {
        if (document.isDirty) {
          log('Document dirty; defer regeneration for function', fn.name);
          continue;
        }
        try {
          log('Summarizing function', fn.name, 'lines', nextStart - fn.startLine);
          const rawUnits = await summarizeFunctionSemanticUnits(code, document.languageId);

          const lines = code.split(/\r?\n/);
          const units: ChunkSummary[] = rawUnits.map((unit, idx) => {
            const chunkStartRel = unit.line;
            const chunkEndRel = (idx + 1 < rawUnits.length) ? rawUnits[idx + 1].line - 1 : lines.length;
            const chunkCode = lines.slice(chunkStartRel - 1, chunkEndRel).join('\n');
            return { line: unit.line, chunkCode, summary: unit.summary };
          });

          fnSummary = { liveCode: code, lastSavedCode: code, startLine: fn.startLine, units };

          // Replace or add in updatedSummaries
          const idxExisting = updatedSummaries.findIndex(s => s.liveCode === code);
          if (idxExisting >= 0) {
            updatedSummaries[idxExisting] = fnSummary;
          } else {
            updatedSummaries.push(fnSummary);
          }
          matched.add(fnSummary);
          summariesChanged = true;
          log('LLM returned', units.length, 'units');
        } catch (err) {
          log('Failed to summarize function', fn.name, err);
          fnSummary = undefined;
        }
      } else {
        if (fnSummary) {
          // This should never happen?
          if (fnSummary.startLine !== fn.startLine) {
            fnSummary.startLine = fn.startLine;
            const idx = updatedSummaries.findIndex(s => s.liveCode === code);
            if (idx >= 0) updatedSummaries[idx] = fnSummary;
            summariesChanged = true;
          }
          // This should never happen?
          if (fnSummary.liveCode !== code) {
            fnSummary.liveCode = code;
            const idx2 = updatedSummaries.findIndex(s => s.liveCode === code);
            if (idx2 >= 0) updatedSummaries[idx2] = fnSummary;
          }
        }
        matched.add(fnSummary);
        log(`Using cached summaries for function ${fn.name}`);
      }

      // function-level summary CodeLens 
      if (fnSummary && fnSummary.units.length) {
        const functionSummaryText = fnSummary.units[0].summary;
        const fnPos = new vscode.Position(fn.startLine, 0);
        lenses.push(new vscode.CodeLens(new vscode.Range(fnPos, fnPos), {
          title: functionSummaryText,
          command: 'codetorch.nop',
          tooltip: 'Function summary'
        }));
      }

      log('function summary exists for ', fn.name, fnSummary ? 'yes' : 'no');
      // line-level summaries as CodeLens
      if (fnSummary) {
        for (const unit of fnSummary.units.slice(1)) {
          const insertionLine = Math.min(fn.startLine + unit.line - 1, nextStart - 1);
          const pos = new vscode.Position(insertionLine, 0);
          lenses.push(new vscode.CodeLens(new vscode.Range(pos, pos), {
            title: unit.summary,
            command: 'codetorch.nop',
            tooltip: 'Code summary'
          }));
        }
      }
    }

    this.cache.set(document.uri.toString(), lenses);

    if (!document.isDirty) {
      // Remove summaries that did not match any current function after newly generated summaries
      const finalSummaries = updatedSummaries.filter(s => matched.has(s));
      if (summariesChanged || finalSummaries.length !== cachedSummaries.length) {
        await saveSummary(document, finalSummaries);
      }
    } else {
      await saveSummary(document, updatedSummaries);
    }

    return lenses;
  }

  /**
   * Called on document save. Clears in-memory CodeLens cache so that
   * provideCodeLenses() recomputes summaries lazily after the save.
   */
   handleDocumentSave(document: vscode.TextDocument) {
    log('handleDocumentSave', document.uri.toString());
    const uri = document.uri.toString();
    // Skip certain file types that shouldn't be processed
    if (uri.includes('extension-output') || 
        uri.includes('extension-log') ||
        uri.includes('.git') ||
        uri.includes('node_modules') ||
        uri.includes('.codetorch') ||
        document.uri.scheme !== 'file') {
      return; // Don't process this document
    }
    this.cache.delete(uri);
    // Notify VS Code to re-request CodeLenses after save
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Live-shift: adjust cached line numbers when the user edits the document.
   * Lightweight – no LLM calls.
   */
  async handleTextDocumentChange(e: vscode.TextDocumentChangeEvent) {
    const uri = e.document.uri.toString();

    if (uri.includes('extension-output') ||
        uri.includes('extension-log') ||
        uri.includes('.git') ||
        uri.includes('node_modules') ||
        uri.includes('.codetorch') ||
        e.document.uri.scheme !== 'file') {
      return;
    }
    
    log('handleTextDocumentChange', e.document.uri.toString());

    const summaries = await loadSummary(e.document);
    if (!summaries || summaries.length === 0) return;

    const functions = await detectFunctions(e.document);
    // Sort by startLine to compute end lines
    
    const sortedFns = [...functions].sort((a,b)=>a.startLine-b.startLine);

    // Process changes from bottom to top to avoid double-shifting
    for (const change of [...e.contentChanges].reverse()) {
      const changeStart = change.range.start.line;
      const changeEnd   = change.range.end.line;
      const linesAdded  = change.text.split('\n').length - 1;
      const linesRemoved = changeEnd - changeStart;
      const delta = linesAdded - linesRemoved;
      if (delta === 0) continue;

      // Shift startLine for functions below the edit
      for (const fs of summaries) {
        if (fs.startLine > changeStart) {
          fs.startLine += delta;
        }
      }

      // Find containing function (in up-to-date positions)
      let containingIdx = -1;
      for (let i=0;i<sortedFns.length;i++) {
        const fn = sortedFns[i];
        const fnStart = fn.startLine;
        const fnEnd   = (i+1<sortedFns.length)? sortedFns[i+1].startLine : e.document.lineCount;
        if (changeStart >= fnStart && changeStart <= fnEnd) { containingIdx = i; break; }
      }
      
      if (containingIdx !== -1) {
        const fnInfo = sortedFns[containingIdx];
        const fs = summaries.find(s => s.startLine === fnInfo.startLine);
        if (fs) {
          // Update functionCode to reflect the current content
          const nextStart = (containingIdx + 1 < sortedFns.length) ? sortedFns[containingIdx + 1].startLine : e.document.lineCount;
          fs.liveCode = e.document.getText(new vscode.Range(fnInfo.startLine, 0, nextStart, 0));
          
          const relStart0 = changeStart - fs.startLine; // 0-based
          for (const unit of fs.units) {
            if (unit.line - 1 > relStart0) {
              unit.line += delta;
            }
          }
        }
      }
    }

    await saveSummary(e.document, summaries);
    // Clear cache to force re-render from disk with updated line numbers
    this.cache.delete(uri);
  }

  /**
   * Clean up timeouts when the provider is disposed
   */

  dispose() {
    for (const timeout of this.updateTimeout.values()) {
      clearTimeout(timeout);
    }
    this.updateTimeout.clear();
    this.cache.clear();
  }
} 
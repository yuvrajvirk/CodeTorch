import * as vscode from 'vscode';
import { detectFunctions } from './parser';
import { summarizeFunctionSemanticUnits, SemanticUnitComment } from './llm';
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

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    log('provideCodeLenses start', document.uri.toString());
    const cached = this.cache.get(document.uri.toString());
    if (cached) {
      log('Using cached CodeLens', cached.length);
      return cached;
    }

    const functions = await detectFunctions(document);
    const cachedSummary = await loadSummary(document);
    const summariesToPersist: SemanticUnitComment[] = cachedSummary ? [...cachedSummary] : [];

    const lenses: vscode.CodeLens[] = [];

    // Compute end lines for each function
    const sorted = [...functions].sort((a, b) => a.startLine - b.startLine);
    for (let i = 0; i < sorted.length; i++) {
      const fn = sorted[i];
      const nextStart = (i + 1 < sorted.length) ? sorted[i + 1].startLine : document.lineCount;
      const code = document.getText(new vscode.Range(fn.startLine, 0, nextStart, 0));

      let summaryLines: SemanticUnitComment[] | undefined = undefined;
      if (cachedSummary) {
        summaryLines = cachedSummary.filter(u => u.line >= fn.startLine + 1 && u.line <= nextStart);
      }
      if (!summaryLines || summaryLines.length === 0) {
        try {
          log('Summarizing function', fn.name, 'lines', nextStart - fn.startLine);
          summaryLines = await summarizeFunctionSemanticUnits(code, document.languageId);
          summariesToPersist.push(...summaryLines);
          log('LLM returned', summaryLines.length, 'units');
        } catch (err) {
          log('Failed to summarize function', fn.name, err);
          summaryLines = [];
        }
      }

      // function-level summary CodeLens (first unit or synthesized)
      if (summaryLines.length) {
        const functionSummary = summaryLines[0].summary;
        const fnPos = new vscode.Position(fn.startLine, 0);
        lenses.push(new vscode.CodeLens(new vscode.Range(fnPos, fnPos), {
          title: functionSummary,
          command: 'codetorch.nop',
          tooltip: 'Function summary'
        }));
      }

      // line-level summaries as CodeLens
      for (const unit of summaryLines.slice(1)) { // skip the first which is used for function summary
        const insertionLine = fn.startLine + Math.min(unit.line - 1, nextStart - fn.startLine - 1);
        const pos = new vscode.Position(insertionLine, 0);
        lenses.push(new vscode.CodeLens(new vscode.Range(pos, pos), {
          title: unit.summary,
          command: 'codetorch.nop',
          tooltip: 'Code summary'
        }));
      }
    }

    this.cache.set(document.uri.toString(), lenses);
    if (summariesToPersist.length) {
      await saveSummary(document, summariesToPersist);
    }
    return lenses;
  }

  // Clear cache when document changes
  onDidChangeDocument(e: vscode.TextDocument) {
    this.cache.delete(e.uri.toString());
  }
} 
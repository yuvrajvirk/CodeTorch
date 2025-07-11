import * as vscode from 'vscode';
import { detectFunctions, FunctionInfo } from './parser';
import { summarizeFunctionSemanticUnits, ChunkSummary, FunctionSummary } from './llm';
import { log } from './utils';
import { loadSummary, saveSummary } from './storage';

function summariesEnabled(): boolean {
  return vscode.workspace.getConfiguration('codetorch').get<boolean>('enableSummaries', true);
}

function summariesVisible(): boolean {
  return vscode.workspace.getConfiguration('codetorch').get<boolean>('showSummaries', true);
}

interface PendingSummaryTask {
  fn: FunctionInfo;
  code: string;
  startLine: number;
}

export class FunctionSummaryCodeLensProvider implements vscode.CodeLensProvider {
  private cache = new Map<string, vscode.CodeLens[]>(); // key: document URI
  private updateTimeout = new Map<string, NodeJS.Timeout>(); // key: document URI

  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const enabled = summariesEnabled();
    const visible = summariesVisible();

    if (!enabled) {
      return [];
    }

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

    const sorted = [...functions].sort((a, b) => a.startLine - b.startLine);

    const tasksToGenerate: PendingSummaryTask[] = [];
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

        tasksToGenerate.push({ fn, code, startLine: fn.startLine });

        if (fnSummary) {
          matched.add(fnSummary);
        }
      } else {
        if (fnSummary) {
          if (fnSummary.startLine !== fn.startLine) {
            fnSummary.startLine = fn.startLine;
            const idx = updatedSummaries.findIndex(s => s.liveCode === code);
            if (idx >= 0) updatedSummaries[idx] = fnSummary;
            summariesChanged = true;
          }
          if (fnSummary.liveCode !== code) {
            fnSummary.liveCode = code;
            const idx2 = updatedSummaries.findIndex(s => s.liveCode === code);
            if (idx2 >= 0) updatedSummaries[idx2] = fnSummary;
          }
        }
        matched.add(fnSummary);
        log(`Using cached summaries for function ${fn.name}`);
      }

      // TODO: when implement proper function summaries, add this back in
      // if (visible && fnSummary && fnSummary.units.length) {
      //   const functionSummaryText = fnSummary.units[0].summary;
      //   const fnPos = new vscode.Position(fn.startLine, 0);
      //   lenses.push(new vscode.CodeLens(new vscode.Range(fnPos, fnPos), {
      //     title: functionSummaryText,
      //     command: 'codetorch.nop',
      //     tooltip: 'Function summary'
      //   }));
      // }
      // log('function summary exists for ', fn.name, fnSummary ? 'yes' : 'no');

      if (visible && fnSummary) {
        for (const unit of fnSummary.units) {
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

    if (tasksToGenerate.length > 0 && !document.isDirty) {
      this.scheduleSummaryGeneration(document, tasksToGenerate);
    }

    this.cache.set(document.uri.toString(), lenses);

    if (!document.isDirty) {
      const finalSummaries = updatedSummaries.filter(s => matched.has(s));
      if (summariesChanged || finalSummaries.length !== cachedSummaries.length) {
        await saveSummary(document, finalSummaries);
      }
    } else {
      await saveSummary(document, updatedSummaries);
    }

    return lenses;
  }

  private scheduleSummaryGeneration(document: vscode.TextDocument, tasks: PendingSummaryTask[]) {
    if (!summariesEnabled()) return; // Respect global setting

    const uri = document.uri.toString();

    if (this.updateTimeout.has(uri)) return;

    const timeout = setTimeout(async () => {
      for (const task of tasks) {
        if (document.isDirty) break;

        try {
          log('Async summarizing function', task.fn.name);
          const rawUnits = await summarizeFunctionSemanticUnits(task.code, document.languageId);

          const lines = task.code.split(/\r?\n/);
          const units: ChunkSummary[] = rawUnits.map((unit, idx) => {
            const chunkStartRel = unit.line;
            const chunkEndRel = (idx + 1 < rawUnits.length) ? rawUnits[idx + 1].line - 1 : lines.length;
            const chunkCode = lines.slice(chunkStartRel - 1, chunkEndRel).join('\n');
            return { line: unit.line, chunkCode, summary: unit.summary };
          });

          const fnSummary: FunctionSummary = {
            liveCode: task.code,
            lastSavedCode: task.code,
            startLine: task.startLine,
            units
          };

          const cachedSummaries = await loadSummary(document) ?? [];
          const idxExisting = cachedSummaries.findIndex(s => s.liveCode === task.code);
          if (idxExisting >= 0) {
            cachedSummaries[idxExisting] = fnSummary;
          } else {
            cachedSummaries.push(fnSummary);
          }
          await saveSummary(document, cachedSummaries);

          this.cache.delete(uri);
          this._onDidChangeCodeLenses.fire();
        } catch (err) {
          log('Failed to asynchronously summarize function', task.fn.name, err);
        }
      }

      this.updateTimeout.delete(uri);
    }, 0);

    this.updateTimeout.set(uri, timeout);
  }

   handleDocumentSave(document: vscode.TextDocument) {
    log('handleDocumentSave', document.uri.toString());
    const uri = document.uri.toString();
    if (uri.includes('extension-output') || 
        uri.includes('extension-log') ||
        uri.includes('.git') ||
        uri.includes('node_modules') ||
        uri.includes('.codetorch') ||
        document.uri.scheme !== 'file') {
      return; // Don't process this document
    }
    this.cache.delete(uri);
    this._onDidChangeCodeLenses.fire();
  }

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
    
    const sortedFns = [...functions].sort((a,b)=>a.startLine-b.startLine);

    for (const change of [...e.contentChanges].reverse()) {
      const changeStart = change.range.start.line;
      const changeEnd   = change.range.end.line;
      const linesAdded  = change.text.split('\n').length - 1;
      const linesRemoved = changeEnd - changeStart;
      const delta = linesAdded - linesRemoved;

      for (const fs of summaries) {
        if (fs.startLine > changeStart) {
          fs.startLine += delta;
        }
      }

      let containingIdx = -1;
      for (let i=0;i<sortedFns.length;i++) {
        const fn = sortedFns[i];
        const fnStart = fn.startLine;
        const fnEnd   = (i+1<sortedFns.length)? sortedFns[i+1].startLine : e.document.lineCount;
        if (changeStart >= fnStart && changeStart <= fnEnd) { containingIdx = i; break; }
      }

      log('found containingIdx', containingIdx);
      
      if (containingIdx !== -1) {
        log('found fn', sortedFns[containingIdx].name);
        const fnInfo = sortedFns[containingIdx];
        const fs = summaries.find(s => s.startLine === fnInfo.startLine);
        if (fs) {
          log('found fs', fs);
          const nextStart = (containingIdx + 1 < sortedFns.length) ? sortedFns[containingIdx + 1].startLine : e.document.lineCount;
          fs.liveCode = e.document.getText(new vscode.Range(fnInfo.startLine, 0, nextStart, 0));
          
          if (delta !== 0) {
            const relStart0 = changeStart - fs.startLine; // 0-based
            for (const unit of fs.units) {
              if (unit.line - 1 > relStart0) {
                unit.line += delta;
              }
            }
          }
        }
      }
    }

    log('summaries', summaries);
    await saveSummary(e.document, summaries);
    this.cache.delete(uri);
  }


  dispose() {
    for (const timeout of this.updateTimeout.values()) {
      clearTimeout(timeout);
    }
    this.updateTimeout.clear();
    
    this.cache.clear();
  }

  public refresh() {
    this.cache.clear();
    this._onDidChangeCodeLenses.fire();
  }
} 
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  cacheFilePath, loadSummary, saveSummary
} from '../storage';                   // compiled path becomes …/out/…
import { until, wait } from './utils';

suite('Live line-shift (dirty document)', () => {
  const sampleCode = [
    'function foo() {',
    '  return 1;',
    '}',
    '',
    'function bar() {',
    '  return 2;',
    '}'
  ].join('\n');

  const summariesFixture = [
    {
      liveCode: sampleCode,
      lastSavedCode: sampleCode,
      startLine: 0,
      units: [
        { line: 1, chunkCode: 'function foo() {', summary: 'foo declaration' },
        { line: 2, chunkCode: '  return 1;',      summary: 'returns 1'       }
      ]
    },
    {
      liveCode: sampleCode.split('\n').slice(4).join('\n'),
      lastSavedCode: sampleCode.split('\n').slice(4).join('\n'),
      startLine: 4,
      units: [
        { line: 1, chunkCode: 'function bar() {', summary: 'bar declaration' },
        { line: 2, chunkCode: '  return 2;',      summary: 'returns 2'       }
      ]
    }
  ];

  let fileUri: vscode.Uri;
  let editor: vscode.TextEditor;

  suiteSetup(async () => {
    let root: string;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      // Create a temp folder and add it to the workspace on-the-fly
      const tmpDir = path.join(os.tmpdir(), `codetorch-test-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(tmpDir) });
      root = tmpDir;
    }
    const file = path.join(root, 'sample.ts');
    fs.writeFileSync(file, sampleCode, 'utf8');
    fileUri = vscode.Uri.file(file);

    const dummyDoc = await vscode.workspace.openTextDocument(fileUri);
    await saveSummary(dummyDoc, summariesFixture);

    await vscode.commands.executeCommand('codetorch.nop');

    editor = await vscode.window.showTextDocument(dummyDoc);
  });

  test('editing without saving shifts line numbers only', async () => {
    const summaryFile = cacheFilePath(editor.document)!;
    const initialMtime = fs.statSync(summaryFile).mtimeMs;

    await editor.edit(b => {
      b.insert(new vscode.Position(0, 0), '// heading\n');
    });

    await until(() => fs.statSync(summaryFile).mtimeMs, (mtime) => mtime > initialMtime, 4000, 50);

    const updated = await loadSummary(editor.document);
    assert.ok(updated, 'summary cache should exist');

    assert.strictEqual(updated[0].startLine, 0);
    assert.strictEqual(updated[1].startLine, 5);

    const fooUnits = updated[0].units.map(u => u.line);
    assert.deepStrictEqual(fooUnits, [1, 2]);

    const barUnits = updated[1].units.map(u => u.line);
    assert.deepStrictEqual(barUnits, [1, 2]); 

    assert.strictEqual(updated!.length, summariesFixture.length);

    assert.strictEqual(updated![0].units[0].summary, 'foo declaration');
    assert.strictEqual(updated![0].units[1].summary, 'returns 1');
    assert.strictEqual(updated![1].units[0].summary, 'bar declaration');
    assert.strictEqual(updated![1].units[1].summary, 'returns 2');
  });
});
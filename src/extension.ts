// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { detectFunctions, FunctionInfo } from './parser';
import { outputChannel, log } from './utils';
import { computeCallGraph, CallGraphEntry } from './callgraph';
import { saveCallGraph, loadCallGraph } from './storage';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "codetorch" is now active!');
	outputChannel.show(true);
	log('CodeTorch extension activated');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('codetorch.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from CodeTorch!');
	});

	const annotateDisposable = vscode.commands.registerCommand('codetorch.annotateCurrentFile', () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor to annotate.');
			return;
		}

		detectFunctions(editor.document).then((functions) => {
			if (functions.length === 0) {
				vscode.window.showInformationMessage('No functions detected in current file.');
				return;
			}

			const list = functions.map((f: FunctionInfo) => `• ${f.name} (line ${f.startLine + 1})`).join('\n');
			vscode.window.showInformationMessage(`Detected functions:\n${list}`);
		});
	});

	const summarizeDisposable = vscode.commands.registerCommand('codetorch.summarizeFunction', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor to summarize.');
			return;
		}

		const document = editor.document;
		const cursorLine = editor.selection.active.line;

		const functions = await detectFunctions(document);
		if (functions.length === 0) {
			vscode.window.showInformationMessage('No functions detected in current file.');
			return;
		}

		// Find the function that contains the cursor
		let current: FunctionInfo | undefined;
		for (let i = 0; i < functions.length; i++) {
			const fn = functions[i];
			const nextStart = (i + 1 < functions.length) ? functions[i + 1].startLine : document.lineCount;
			if (cursorLine >= fn.startLine && cursorLine < nextStart) {
				current = fn;
				break;
			}
		}

		if (!current) {
			vscode.window.showInformationMessage('Cursor is not inside any detected function.');
			return;
		}

		const fnStart = current.startLine;
		const nextStart = functions
			.filter(f => f.startLine > fnStart)
			.map(f => f.startLine)
			.sort((a, b) => a - b)[0] ?? document.lineCount;

		const code = document.getText(new vscode.Range(fnStart, 0, nextStart, 0));

		// Call LLM summariser
		try {
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore - compiled JS requires explicit extension
			const { summarizeFunction } = await import('./llm.js');
			const summary = await summarizeFunction(code, document.languageId);
			vscode.window.showInformationMessage(summary, { modal: true });
		} catch (err: any) {
			console.error('LLM summarization failed', err);
			vscode.window.showErrorMessage('LLM summarization failed: ' + (err?.message ?? err));
		}
	});

	// Collect call graph (current file)
	const callGraphDisposable = vscode.commands.registerCommand('codetorch.collectCallGraphCurrentFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor to analyse.');
			return;
		}

		try {
			const graph = await computeCallGraph(editor.document);
			await saveCallGraph(editor.document, graph);
			log('Call graph saved', graph);
			vscode.window.showInformationMessage(`Call graph collected for ${graph.length} functions.`);
		} catch (err: any) {
			console.error('Call graph generation failed', err);
			vscode.window.showErrorMessage('Call graph generation failed: ' + (err?.message ?? err));
		}
	});

	// View call graph (current file)
	const viewCallGraphDisposable = vscode.commands.registerCommand('codetorch.viewCallGraphCurrentFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor to view.');
			return;
		}

		try {
			const graph = await loadCallGraph<CallGraphEntry[]>(editor.document);
			if (!graph) {
				vscode.window.showInformationMessage('No call graph data found. Run "Collect Call Graph" first.');
				return;
			}

			// Create a formatted view of the call graph
			const formattedGraph = graph.map((entry: CallGraphEntry) => {
				return `${entry.name}:
 Callers (depth 1): ${entry.depth1Callers.length > 0 ? entry.depth1Callers.join(', ') : 'none'}
 Callers (depth 2): ${entry.depth2Callers.length > 0 ? entry.depth2Callers.join(', ') : 'none'}
 Callees (depth 1): ${entry.depth1Callees.length > 0 ? entry.depth1Callees.join(', ') : 'none'}
 Callees (depth 2): ${entry.depth2Callees.length > 0 ? entry.depth2Callees.join(', ') : 'none'}`;
			}).join('\n\n');

			// Show in a new document
			const doc = await vscode.workspace.openTextDocument({
				content: `Call Graph for ${editor.document.fileName}:\n\n${formattedGraph}`,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(doc);
		} catch (err: any) {
			console.error('Failed to view call graph:', err);
			vscode.window.showErrorMessage('Failed to view call graph: ' + (err?.message ?? err));
		}
	});

	const noopDisposable = vscode.commands.registerCommand('codetorch.nop', () => {});

	// Register CodeLens provider for semantic summaries
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore - extension .js added at build time
	import('./codelens.js').then(mod => {
		const codelensProvider = new mod.FunctionSummaryCodeLensProvider();
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codelensProvider)
		);

		// Refresh summaries on document save
		const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
			codelensProvider.handleDocumentSave(doc);
		});
		context.subscriptions.push(saveListener);

		// Lightweight live shift on each edit (no LLM calls)
		const changeListener = vscode.workspace.onDidChangeTextDocument((e)=>{
			codelensProvider.handleTextDocumentChange(e);
		});
		context.subscriptions.push(changeListener);

		// Register dispose handler for the codelens provider
		context.subscriptions.push({
			dispose: () => codelensProvider.dispose()
		});
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(annotateDisposable);
	context.subscriptions.push(summarizeDisposable);
	context.subscriptions.push(callGraphDisposable);
	context.subscriptions.push(viewCallGraphDisposable);
	context.subscriptions.push(noopDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

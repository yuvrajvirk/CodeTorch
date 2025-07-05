// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { detectFunctions, FunctionInfo } from './parser';
import { outputChannel, log } from './utils';

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

	const noopDisposable = vscode.commands.registerCommand('codetorch.nop', () => {});

	// Register CodeLens provider for semantic summaries
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore - extension .js added at build time
	import('./codelens.js').then(mod => {
		const codelensProvider = new mod.FunctionSummaryCodeLensProvider();
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codelensProvider)
		);
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(annotateDisposable);
	context.subscriptions.push(summarizeDisposable);
	context.subscriptions.push(noopDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

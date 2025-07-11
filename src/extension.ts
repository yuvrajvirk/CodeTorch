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

	// === CodeTorch Status Bar Quick Menu ===
	let codelensProviderRef: { refresh: () => void; handleDocumentSave: (doc: vscode.TextDocument) => void } | undefined;
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'codetorch.showQuickMenu';

	// Helper to keep the status bar in sync with user settings
	const updateStatusBar = () => {
		const cfg = vscode.workspace.getConfiguration('codetorch');
		const visible = cfg.get<boolean>('showSummaries', true);
		const enabled = cfg.get<boolean>('enableSummaries', true);
		if (!enabled) {
			statusBar.text = '$(circle-slash) CodeTorch Off';
			statusBar.tooltip = 'CodeTorch summaries generation disabled';
		} else if (!visible) {
			statusBar.text = '$(eye-closed) CodeTorch Hidden';
			statusBar.tooltip = 'CodeTorch summaries hidden (generation active)';
		} else {
			statusBar.text = '$(symbol-function) CodeTorch On';
			statusBar.tooltip = 'CodeTorch summaries visible';
		}
		log('Updated status bar');
		statusBar.show();
		// Trigger CodeLens refresh immediately
		if (codelensProviderRef) {
			codelensProviderRef.refresh();
		}
	};

	updateStatusBar();
	context.subscriptions.push(statusBar);

	// Command that shows a quick-pick menu to toggle CodeTorch options
	const quickMenuDisposable = vscode.commands.registerCommand('codetorch.showQuickMenu', async () => {
		const cfg = vscode.workspace.getConfiguration('codetorch');
		const visible = cfg.get<boolean>('showSummaries', true);
		const enabled = cfg.get<boolean>('enableSummaries', true);

		const selected = await vscode.window.showQuickPick([
			{ label: `${visible ? '$(check)' : '$(x)'} Summaries Visibility`, description: visible ? 'Currently ON – click to turn OFF' : 'Currently OFF – click to turn ON' },
			{ label: `${enabled ? '$(check)' : '$(x)'} Summaries Generation`, description: enabled ? 'Currently ENABLED – click to DISABLE' : 'Currently DISABLED – click to ENABLE' }
		], { placeHolder: 'CodeTorch settings' });

		if (!selected) { return; }

		if (selected.label.includes('Visibility')) {
			await cfg.update('showSummaries', !visible, vscode.ConfigurationTarget.Global);
		} else if (selected.label.includes('Generation')) {
			const newEnabled = !enabled;
			await cfg.update('enableSummaries', newEnabled, vscode.ConfigurationTarget.Global);
			if (!newEnabled) {
				await cfg.update('showSummaries', false, vscode.ConfigurationTarget.Global);
			}
		}

		updateStatusBar();
	});
	context.subscriptions.push(quickMenuDisposable);

	// React to configuration changes made elsewhere
	const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('codetorch.showSummaries') || e.affectsConfiguration('codetorch.enableSummaries')) {
			updateStatusBar();
		}
	});
	context.subscriptions.push(cfgListener);

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

	const regenerateDisposable = vscode.commands.registerCommand('codetorch.regenerateSummaries', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor to regenerate.');
			return;
		}

		if (!codelensProviderRef) {
			vscode.window.showErrorMessage('CodeTorch not initialised yet.');
			return;
		}

		// Attempt to save the document so that it is not dirty; this guarantees summarisation runs
		await editor.document.save();

		// Mimic the save-triggered regeneration explicitly
		codelensProviderRef.handleDocumentSave(editor.document);
	});
	context.subscriptions.push(regenerateDisposable);

	const noopDisposable = vscode.commands.registerCommand('codetorch.nop', () => {});

	// Test if DocumentSymbolProvider is available for a given document
	const testDocumentSymbolProvider = async (document: vscode.TextDocument): Promise<boolean> => {
		try {
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);
			// If we get a result (even empty array), the provider is available
			return Array.isArray(symbols);
		} catch (error) {
			log('DocumentSymbolProvider test failed:', error);
			return false;
		}
	};

	// Wait for DocumentSymbolProvider to be available with max delay
	const waitForDocumentSymbolProvider = async (maxDelayMs: number = 10000): Promise<boolean> => {
		const startTime = Date.now();
		const checkInterval = 100; // Check every 100ms
		
		while (Date.now() - startTime < maxDelayMs) {
			// Try to find a document to test with
			let testDocument: vscode.TextDocument | undefined;
			
			if (vscode.window.activeTextEditor) {
				testDocument = vscode.window.activeTextEditor.document;
			} else {
				// Try to get any open document
				const documents = vscode.workspace.textDocuments;
				testDocument = documents.find(doc => doc.uri.scheme === 'file');
			}
			
			if (testDocument) {
				const isAvailable = await testDocumentSymbolProvider(testDocument);
				if (isAvailable) {
					log('DocumentSymbolProvider is available');
					return true;
				}
			}
			
			// Wait before next check
			await new Promise(resolve => setTimeout(resolve, checkInterval));
		}
		
		log('DocumentSymbolProvider not available after timeout');
		return false;
	};

	// Defer CodeLens provider registration until language services are ready
	const initializeCodeLensProvider = async () => {
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore - extension .js added at build time
		const mod = await import('./codelens.js');
		const codelensProvider = new mod.FunctionSummaryCodeLensProvider();
		codelensProviderRef = codelensProvider;
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codelensProvider)
		);

		// Refresh summaries on document save
		const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
			const trigger = vscode.workspace.getConfiguration('codetorch').get<string>('regenerationTrigger', 'onSave');
			if (trigger === 'onSave') {
				codelensProvider.handleDocumentSave(doc);
			}
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

		log('CodeLens provider initialized');
	};

	// Initialize CodeLens provider when DocumentSymbolProvider is ready
	const initializeWhenReady = async () => {
		log('Waiting for DocumentSymbolProvider to be available...');
		const isReady = await waitForDocumentSymbolProvider(10000); // 10 second max delay
		
		if (isReady) {
			await initializeCodeLensProvider();
		} else {
			log('DocumentSymbolProvider not available, initializing CodeLens provider anyway');
			await initializeCodeLensProvider();
		}
	};

	// Start initialization
	initializeWhenReady();

	context.subscriptions.push(noopDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

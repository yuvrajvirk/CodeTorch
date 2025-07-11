import * as vscode from 'vscode';
import { log } from './utils';

export interface FunctionInfo {
	name: string;
	startLine: number; // 0-based line index
}

const FUNCTION_DECLARATION = /function\s+([A-Za-z0-9_$]+)\s*\(/;
const ARROW_FUNCTION = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*\([^)]*\)\s*=>/;

/** Recursively traverse DocumentSymbol tree collecting functions & methods */
function walkDocumentSymbols(symbols: vscode.DocumentSymbol[] | undefined, out: FunctionInfo[], document: vscode.TextDocument) {
	log('walkDocumentSymbols', symbols);
	if (!symbols) return;
	for (const sym of symbols) {
		if (sym.kind === vscode.SymbolKind.Function || sym.kind === vscode.SymbolKind.Method) {
			out.push({ name: sym.name, startLine: sym.range.start.line });

			// Do NOT recurse into children of functions/methods to avoid
			// capturing inline arrow functions or nested anonymous callbacks
			// that would incorrectly split outer function bodies.
			continue;
		}

		// Recurse into children for non-function symbols (e.g., classes, namespaces)
		walkDocumentSymbols(sym.children, out, document);
	}
}

/**
 * Detect functions via VS Code's built-in DocumentSymbolProvider (leveraging LSP).
 * Falls back to simple regex when providers are unavailable.
 */
export async function detectFunctions(document: vscode.TextDocument): Promise<FunctionInfo[]> {
	const infos: FunctionInfo[] = [];

	try {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			document.uri
		);
		if (symbols && symbols.length) {
			walkDocumentSymbols(symbols, infos, document);
		}
	} catch (err) {
		log('DocumentSymbolProvider failed', err);
	}


	// Fallback to naive regex if nothing found
	if (infos.length === 0) {
		log('No DocumentSymbolProvider found, falling back to regex');
		for (let i = 0; i < document.lineCount; i++) {
			const text = document.lineAt(i).text;
			let match = FUNCTION_DECLARATION.exec(text);
			if (match) {
				infos.push({ name: match[1], startLine: i });
				continue;
			}
			match = ARROW_FUNCTION.exec(text);
			if (match) {
				infos.push({ name: match[1], startLine: i });
			}
		}
	}

	return infos;
} 
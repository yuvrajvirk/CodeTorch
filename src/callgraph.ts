import * as vscode from 'vscode';
import { detectFunctions } from './parser';

/**
 * Call graph information for a single function limited to 2 levels deep.
 */
export interface CallGraphEntry {
  /** Function name */
  name: string;
  /** Direct callers (depth = 1) */
  depth1Callers: string[];
  /** Callers two hops away (depth = 2, excluding depth 1 & self) */
  depth2Callers: string[];
  /** Direct callees (depth = 1) */
  depth1Callees: string[];
  /** Callees two hops away (depth = 2, excluding depth 1 & self) */
  depth2Callees: string[];
}

/**
 * Build a call graph using VS Code's Language Server Protocol call hierarchy provider.
 * 
 * This approach leverages the language server's semantic understanding of the code,
 * providing much more accurate results than regex-based detection.
 * 
 * Strategy:
 * 1. Detect all functions in the document using existing parser
 * 2. For each function, query the call hierarchy provider for both incoming and outgoing calls
 * 3. Build depth-1 and depth-2 relationships by traversing the hierarchy
 * 4. Filter results to only include functions within the same file
 * 5. Fall back to regex-based detection if language server doesn't support call hierarchy
 */
export async function computeCallGraph(document: vscode.TextDocument): Promise<CallGraphEntry[]> {
  const functions = await detectFunctions(document);
  if (functions.length === 0) return [];

  // Get all function names for filtering
  const functionNames = new Set(functions.map(f => f.name));
  
  // Maps to store call relationships
  const directCallees = new Map<string, Set<string>>();
  const directCallers = new Map<string, Set<string>>();

  // Initialize maps for all functions
  for (const func of functions) {
    directCallees.set(func.name, new Set());
    directCallers.set(func.name, new Set());
  }

  // Check if call hierarchy is supported
  const hasCallHierarchySupport = await checkCallHierarchySupport(document);
  
  if (hasCallHierarchySupport) {
    // Use language server approach
    await buildCallGraphWithLanguageServer(functions, directCallees, directCallers, functionNames, document);
  } else {
    // Fall back to regex-based approach
    await buildCallGraphWithRegex(functions, directCallees, directCallers, document);
  }

  // Build depth-2 relationships
  const buildDepth2 = (
    name: string,
    directMap: Map<string, Set<string>>
  ): string[] => {
    const depth1 = directMap.get(name) ?? new Set<string>();
    const depth2 = new Set<string>();

    for (const intermediate of depth1) {
      const next = directMap.get(intermediate);
      if (!next) continue;
      for (const candidate of next) {
        if (candidate !== name && !depth1.has(candidate)) {
          depth2.add(candidate);
        }
      }
    }
    return Array.from(depth2);
  };

  // Build final result
  const entries: CallGraphEntry[] = [];
  for (const func of functions) {
    const depth1Callees = Array.from(directCallees.get(func.name) ?? []);
    const depth1Callers = Array.from(directCallers.get(func.name) ?? []);
    const depth2Callees = buildDepth2(func.name, directCallees);
    const depth2Callers = buildDepth2(func.name, directCallers);

    entries.push({
      name: func.name,
      depth1Callers: depth1Callers,
      depth2Callers: depth2Callers,
      depth1Callees: depth1Callees,
      depth2Callees: depth2Callees,
    });
  }

  return entries;
}

/**
 * Check if the language server supports call hierarchy for this document.
 */
async function checkCallHierarchySupport(document: vscode.TextDocument): Promise<boolean> {
  try {
    // Try to execute call hierarchy provider to see if it's supported
    const testPosition = new vscode.Position(0, 0);
    const result = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.executeCallHierarchyProvider',
      document.uri,
      testPosition
    );
    // If we get a result (even empty), the provider is available
    return Array.isArray(result);
  } catch (error) {
    console.warn('Call hierarchy not supported for this document:', error);
    return false;
  }
}

/**
 * Build call graph using language server call hierarchy.
 */
async function buildCallGraphWithLanguageServer(
  functions: any[],
  directCallees: Map<string, Set<string>>,
  directCallers: Map<string, Set<string>>,
  functionNames: Set<string>,
  document: vscode.TextDocument
): Promise<void> {
  // Process each function
  for (const func of functions) {
    try {
      // Get position inside the function (middle of the function)
      const position = new vscode.Position(func.startLine, 0);
      
      // Query call hierarchy provider for this function
      const callHierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.executeCallHierarchyProvider',
        document.uri,
        position
      );

      if (callHierarchyItems && callHierarchyItems.length > 0) {
        // Process incoming calls (callers)
        await processIncomingCalls(callHierarchyItems[0], func.name, directCallers, functionNames, document);
        
        // Process outgoing calls (callees)
        await processOutgoingCalls(callHierarchyItems[0], func.name, directCallees, functionNames, document);
      }
    } catch (error) {
      console.warn(`Failed to get call hierarchy for function ${func.name}:`, error);
    }
  }
}

/**
 * Build call graph using regex-based detection (fallback).
 */
async function buildCallGraphWithRegex(
  functions: any[],
  directCallees: Map<string, Set<string>>,
  directCallers: Map<string, Set<string>>,
  document: vscode.TextDocument
): Promise<void> {
  // Helper to resolve the ending line of a function
  const getEndLine = (index: number): number => {
    if (index + 1 < functions.length) {
      return functions[index + 1].startLine - 1;
    }
    return document.lineCount - 1;
  };

  const funcNames = functions.map(f => f.name);

  // Build direct callees using regex
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const fnEndLine = getEndLine(i);

    // Capture the full text of the function body
    const code = document.getText(
      new vscode.Range(fn.startLine, 0, fnEndLine + 1, 0)
    );

    const callees = new Set<string>();
    for (const candidate of funcNames) {
      if (candidate === fn.name) continue; // skip self
      // Simple call detection with word boundary
      const pattern = new RegExp(`\\b${candidate}\\s*\\(`);
      if (pattern.test(code)) {
        callees.add(candidate);
      }
    }
    directCallees.set(fn.name, callees);
  }

  // Build direct callers from callees
  for (const [caller, callees] of directCallees) {
    for (const callee of callees) {
      directCallers.get(callee)?.add(caller);
    }
  }
}

/**
 * Process incoming calls (callers) for a function using call hierarchy.
 */
async function processIncomingCalls(
  item: vscode.CallHierarchyItem,
  functionName: string,
  directCallers: Map<string, Set<string>>,
  functionNames: Set<string>,
  document: vscode.TextDocument
): Promise<void> {
  try {
    const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls',
      item
    );

    if (incomingCalls) {
      for (const call of incomingCalls) {
        const callerName = call.from.name;
        
        // Only include callers that are functions in the same file
        if (functionNames.has(callerName) && 
            call.from.uri.toString() === document.uri.toString()) {
          directCallers.get(functionName)?.add(callerName);
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to get incoming calls for ${functionName}:`, error);
  }
}

/**
 * Process outgoing calls (callees) for a function using call hierarchy.
 */
async function processOutgoingCalls(
  item: vscode.CallHierarchyItem,
  functionName: string,
  directCallees: Map<string, Set<string>>,
  functionNames: Set<string>,
  document: vscode.TextDocument
): Promise<void> {
  try {
    const outgoingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      'vscode.provideOutgoingCalls',
      item
    );

    if (outgoingCalls) {
      for (const call of outgoingCalls) {
        const calleeName = call.to.name;
        
        // Only include callees that are functions in the same file
        if (functionNames.has(calleeName) && 
            call.to.uri.toString() === document.uri.toString()) {
          directCallees.get(functionName)?.add(calleeName);
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to get outgoing calls for ${functionName}:`, error);
  }
} 
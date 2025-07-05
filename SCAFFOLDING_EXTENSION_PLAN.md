# CodeTorch: Code Line Summarizer Extension

## Goal
Create a VS Code extension that scans the **active editor file**, detects every function, and adds a **natural-language comment explaining each line of code** directly above it.  
This instantly documents intent, boosts readability, and accelerates onboarding—no manual outline required!

---

## User Story
1. **Run command** – User opens the command palette → `CodeTorch: Annotate Current File`.  
2. **Analyse code** – The extension reads the current document (or selection) and detects function boundaries (AST-based when possible, regex fallback).  
3. **Generate summaries** – Code for each function is sent to an LLM with instructions to prepend a concise NL explanation comment (`// >` or language-specific) above every code line.  
4. **Apply annotations** – The annotated code replaces the original or is inserted into a new editor tab, preserving formatting and undo-stack integrity.  
5. **Post-actions** – Quick-pick menu allows users to:  
   - Regenerate summaries with different verbosity.  
   - Strip all NL comments to return to clean code.  
   - View the raw prompt/response JSON for transparency.

---

## Key Features & Tasks

| # | Feature | VS Code API / Tech | Notes |
|---|---------|-------------------|-------|
| 1 | Command `codetorch.annotateCurrentFile` | `vscode.commands.registerCommand` | Entry point |
| 2 | Parse code & detect functions | `typescript-estree`, `acorn`, or built-in TS Parser; fallback regex per language | Generate AST to find function ranges |
| 3 | Call LLM for summarisation | `fetch` to OpenAI / local; streaming for progress | Chunk by function / token limit |
| 4 | Insert annotated code | `TextEditor.edit` with computed diff | Preserve indentation & EOLs |
| 5 | Post-generation actions | `vscode.window.showQuickPick` | Regenerate / strip comments |
| 6 | Config | `configuration` contribution | Model, temperature, comment prefix, maxTokens |
| 7 | Status / logs | `vscode.window.withProgress` + OutputChannel | Debugging aid |
| 8 | Unit tests | `@vscode/test` + `sinon` | Mock LLM & parser |

---

## Prompt Design (pseudo)
```text
SYSTEM: You are a senior software engineer...
USER:
TASK: Summarise each line of the following <LANGUAGE> function(s).  
RULES:  
1. Return ONLY code with an NL explanation comment *above every line*.  
2. Comment must start with <COMMENT_PREFIX> (e.g. `// >` or `# >`).  
3. Preserve original code exactly; do not merge or split lines.  
4. Maintain indentation between comment and code.
```

---

## Extension Structure
```
codetorch/
├─ src/
│  ├─ extension.ts          ← activate / deactivate, command registration
│  ├─ llm.ts                ← wrapper for API calls
│  ├─ prompt.ts             ← prompt builder utilities
│  ├─ scaffold.ts           ← orchestrates outline → code flow
│  └─ utils.ts
├─ test/
│  └─ scaffold.test.ts
├─ package.json             ← command & configuration contribution points
└─ README.md
```

---

## Implementation Phases
1. **Command & parser scaffold** – Register command, parse current file, echo parsed function list.  
2. **LLM Integration (Done)** – Implemented `llm.ts` using AWS Bedrock (`@aws-sdk/client-bedrock-runtime`) and added summary prompt builder.  
3. **Diff & Edit Application** – Compute and apply annotated diff safely.  
4. **Post-generation UX** – Quick-pick menu, progress, logs.  
5. **Testing & CI** – AST edge cases, diff correctness, LLM mocks.  
6. **Docs & Release** – Usage guide, screencast GIF, publish.

---

## Configuration Keys (`package.json`)
```jsonc
"codetorch": {
  "model": "gpt-4o-mini",
  "temperature": 0.3,
  "commentPrefix": "// >",
  "apiEndpoint": "https://api.openai.com/v1/chat/completions",
  "apiKeySecret": "openaiApiKey"
}
```

---

## Open Questions
- Should comments persist in production code or be optional to strip?
- Performance on very large files (>2k LOC)?
- Language coverage beyond JS/TS, Python, Go?

---

## Definition of Done
- Command appears & works out-of-the-box after installing extension.
- Outline ➔ commented code within 5 s for typical functions.
- >90 % unit-test coverage for internal logic (excluding external API).
- Marketplace listing with demo GIF & changelog. 
# codetorch README

This is the README for your extension "codetorch". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

## CodeLens Semantic Annotations

When you open a file, CodeTorch automatically scans each function and renders natural-language explanations directly in the editor using VS Code's **CodeLens** feature. These grey annotations appear just above the code they describe and do not interfere with editing.

How it works:

1. A `CodeLensProvider` (`FunctionSummaryCodeLensProvider`) detects functions in the document.
2. The source of each function is sent to the configured LLM (Amazon Bedrock by default) with line numbers.
3. The model returns a JSON array containing `{ line, summary }` objects.
4. The provider converts each entry to a CodeLens placed _before_ the referenced line.
5. The CodeLens command is a no-op, so the text is read-only and blends seamlessly with the code.

You can disable or customise this behaviour via the workspace settings:

```jsonc
"codetorch.commentPrefix": "// >",        // change prefix for inline comments
"codetorch.model": "anthropic.claude-3-haiku-20240307-v1:0", // pick a different Bedrock model
"codetorch.awsRegion": "us-east-1"          // Bedrock region
```

**Enjoy!**

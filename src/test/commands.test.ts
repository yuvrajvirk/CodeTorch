import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Command Registration', () => {
    // Keep the list in sync with package.json contributes.commands
    const expectedCommands = [
        'codetorch.helloWorld',
        'codetorch.annotateCurrentFile',
        'codetorch.summarizeFunction',
        'codetorch.collectCallGraphCurrentFile',
        'codetorch.viewCallGraphCurrentFile',
        'codetorch.nop'
    ];

    test('All expected commands are registered', async () => {
        // Trigger extension activation – the NOP command is a cheap way to do this
        await vscode.commands.executeCommand('codetorch.nop');

        const allCommands = await vscode.commands.getCommands(true);
        for (const cmd of expectedCommands) {
            assert.ok(
                allCommands.includes(cmd),
                `Expected command \"${cmd}\" to be present in VS Code but it was not registered.`
            );
        }
    });
}); 
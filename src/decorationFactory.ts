import * as vscode from 'vscode';

export const lineSummaryDecoration = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 24px',
    color: new vscode.ThemeColor('codetorch.lineSummaryForeground'),
    fontStyle: 'italic',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
}); 
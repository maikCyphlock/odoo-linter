import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "odoo-linter" is now active!');

    let disposable = vscode.commands.registerCommand('odoo-linter.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from Odoo Linter!');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

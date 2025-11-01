const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const { lintingFinished } = require('../../extension'); // Corrected path

suite('Odoo Linter JS Extension Test Suite', () => {
    test('Should lint python file missing __init__ import', async () => {
        const testWorkspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const modelPath = path.join(testWorkspaceRoot, 'test_module', 'models', 'test_model.py');
        const modelUri = vscode.Uri.file(modelPath);

        const lintingPromise = new Promise(resolve => {
            lintingFinished.once('finished', (uri) => {
                if (uri.fsPath === modelUri.fsPath) {
                    resolve();
                }
            });
        });

        const modelDoc = await vscode.workspace.openTextDocument(modelUri);

        // Wait for the linting to complete
        await lintingPromise;

        const diagnostics = vscode.languages.getDiagnostics(modelDoc.uri);
        assert.strictEqual(diagnostics.length, 1, 'Should have 1 diagnostic for the model file');
        assert.ok(diagnostics[0].message.includes('__init__.py'), 'Model should have __init__.py warning');
    }).timeout(20000); // Increased timeout
});

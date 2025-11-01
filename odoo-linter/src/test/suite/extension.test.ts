import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

suite('Odoo Linter Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Should lint Odoo module correctly', async () => {
        // Paths to the test files
        const testWorkspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const modelPath = path.join(testWorkspaceRoot, 'test_module', 'models', 'test_model.py');
        const viewPath = path.join(testWorkspaceRoot, 'test_module', 'views', 'test_view.xml');

        // Test the model file for missing import and access rights
        const modelDoc = await vscode.workspace.openTextDocument(modelPath);
        await vscode.window.showTextDocument(modelDoc);

        // Wait for diagnostics to be computed
        await new Promise(resolve => setTimeout(resolve, 2000));

        const modelDiagnostics = vscode.languages.getDiagnostics(modelDoc.uri);
        assert.strictEqual(modelDiagnostics.length, 2, 'Should have 2 diagnostics for the model file');
        assert.ok(modelDiagnostics.some(d => d.message.includes('__init__.py')), 'Model should have __init__.py warning');
        assert.ok(modelDiagnostics.some(d => d.message.includes('access')), 'Model should have access rights warning');

        // Test the view file for missing declaration in manifest
        const viewDoc = await vscode.workspace.openTextDocument(viewPath);
        await vscode.window.showTextDocument(viewDoc);

        // Wait for diagnostics
        await new Promise(resolve => setTimeout(resolve, 2000));

        const viewDiagnostics = vscode.languages.getDiagnostics(viewDoc.uri);
        assert.strictEqual(viewDiagnostics.length, 1, 'Should have 1 diagnostic for the view file');
        assert.ok(viewDiagnostics[0].message.includes('__manifest__.py'), 'View should have __manifest__.py warning');
    }).timeout(10000);
});

const vscode = require('vscode');
const Parser = require('tree-sitter');
const Python = require('tree-sitter-python');
const OdooLinter = require('./odooLinter');

async function updateDiagnostics(document, diagnosticCollection, odooLinter) {
    if (document.languageId !== 'python') {
        diagnosticCollection.set(document.uri, []);
        return;
    }

    try {
        console.log(`Linting file: ${document.fileName}`);
        const lintResults = await odooLinter.lintDocument(document);
        console.log(`Found ${lintResults.length} issues`);
        diagnosticCollection.set(document.uri, lintResults);
    } catch (error) {
        console.error('Error in updateDiagnostics:', error);
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    console.log('Odoo Linter is activating...');
    
    try {
        // Initialize Tree-sitter parser
        const parser = new Parser();
        parser.setLanguage(Python);
        
        console.log('Parser initialized successfully');
        
        // Create Odoo linter instance
        const odooLinter = new OdooLinter(parser, vscode);
        
        // Create diagnostic collection
        const diagnostics = vscode.languages.createDiagnosticCollection("odoo-linter");
        context.subscriptions.push(diagnostics);
        
        console.log('Diagnostics collection created');

        // Debounce linting to avoid excessive processing
        let lintingTimeout;
        const triggerLinting = (document) => {
            if (document.languageId !== 'python') return;
            clearTimeout(lintingTimeout);
            lintingTimeout = setTimeout(() => updateDiagnostics(document, diagnostics, odooLinter), 500);
        };

        // Register event handlers
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(triggerLinting),
            vscode.workspace.onDidSaveTextDocument(triggerLinting),
            vscode.workspace.onDidChangeTextDocument(e => triggerLinting(e.document)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) {
                    triggerLinting(editor.document);
                }
            })
        );

        // Initial linting for active document
        if (vscode.window.activeTextEditor) {
            triggerLinting(vscode.window.activeTextEditor.document);
        }
        
        console.log('Odoo Linter is now active');
    } catch (error) {
        console.error('Failed to activate Odoo Linter:', error);
        vscode.window.showErrorMessage('Failed to activate Odoo Linter. See console for details.');
    }
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
    activate,
    deactivate
};


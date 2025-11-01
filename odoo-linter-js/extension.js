const vscode = require('vscode');
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const diagnostics = vscode.languages.createDiagnosticCollection("odoo-linter");
    context.subscriptions.push(diagnostics);

    let lintingTimeout;

    const triggerLinting = (document) => {
        if (document.languageId !== 'python' && document.languageId !== 'xml') return;
        clearTimeout(lintingTimeout);
        lintingTimeout = setTimeout(() => updateDiagnostics(document, diagnostics), 500);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(triggerLinting),
        vscode.workspace.onDidSaveTextDocument(triggerLinting),
        vscode.workspace.onDidChangeTextDocument(e => triggerLinting(e.document))
    );

    if (vscode.window.activeTextEditor) {
        triggerLinting(vscode.window.activeTextEditor.document);
    }
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.DiagnosticCollection} diagnostics
 */
async function updateDiagnostics(document, diagnostics) {
    const odooModuleRoot = await findOdooModuleRoot(document.uri);
    if (!odooModuleRoot) {
        diagnostics.set(document.uri, []);
        return;
    }

    const problems = [];

    if (document.languageId === 'python') {
        await lintPythonFile(document, odooModuleRoot, problems);
    } else if (document.languageId === 'xml') {
        await lintDataFile(document, odooModuleRoot, problems);
    }

    diagnostics.set(document.uri, problems);
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Uri} odooModuleRoot
 * @param {vscode.Diagnostic[]} problems
 */
async function lintDataFile(document, odooModuleRoot, problems) {
    const manifestUri = vscode.Uri.joinPath(odooModuleRoot, '__manifest__.py');
    try {
        const manifestContent = (await vscode.workspace.fs.readFile(manifestUri)).toString();

        const dataRegex = /'data'\s*:\s*\[([^\]]*)\]/;
        const demoRegex = /'demo'\s*:\s*\[([^\]]*)\]/;

        const dataMatch = manifestContent.match(dataRegex);
        const demoMatch = manifestContent.match(demoRegex);

        const dataFiles = dataMatch ? dataMatch[1].split(',').map(f => f.trim().replace(/['"]/g, '')) : [];
        const demoFiles = demoMatch ? demoMatch[1].split(',').map(f => f.trim().replace(/['"]/g, '')) : [];

        const relativePath = path.relative(odooModuleRoot.fsPath, document.uri.fsPath).replace(/\\/g, '/');

        if (!dataFiles.includes(relativePath) && !demoFiles.includes(relativePath)) {
            const range = new vscode.Range(0, 0, 0, 1);
            problems.push(new vscode.Diagnostic(range, `El archivo no está declarado en la clave 'data' o 'demo' del __manifest__.py.`, vscode.DiagnosticSeverity.Warning));
        }
    } catch (error) {
        // manifest not found or unreadable
    }
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Uri} odooModuleRoot
 * @param {vscode.Diagnostic[]} problems
 */
async function lintPythonFile(document, odooModuleRoot, problems) {
    const fileName = path.basename(document.uri.fsPath);

    // Rule 1: Check __init__.py import
    if (fileName !== '__init__.py') {
        const dirUri = vscode.Uri.joinPath(document.uri, '..');
        const initPyUri = vscode.Uri.joinPath(dirUri, '__init__.py');
        const moduleName = fileName.replace('.py', '');
        const importPattern = new RegExp(`from\\s+\\.\\s+import\\s+${moduleName}`);

        try {
            const initPyContent = (await vscode.workspace.fs.readFile(initPyUri)).toString();
            if (!importPattern.test(initPyContent)) {
                const range = new vscode.Range(0, 0, 0, 1);
                problems.push(new vscode.Diagnostic(range, `El archivo no está importado en el __init__.py del directorio.`, vscode.DiagnosticSeverity.Warning));
            }
        } catch (error) {
            // Don't report if __init__.py is missing
        }
    }

    // Rule 2: Check model access rules
    const fileContent = document.getText();
    if (fileContent.includes('models.Model')) {
        await lintModelAccess(document, odooModuleRoot, problems, fileContent);
    }
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Uri} odooModuleRoot
 * @param {vscode.Diagnostic[]} problems
 * @param {string} fileContent
 */
async function lintModelAccess(document, odooModuleRoot, problems, fileContent) {
    const nameMatch = fileContent.match(/_name\s*=\s*['"]([^'"]+)['"]/);
    if (!nameMatch || !nameMatch[1]) return;

    const modelName = nameMatch[1];
    const modelId = `model_${modelName.replace(/\./g, '_')}`;

    const accessCsvUri = vscode.Uri.joinPath(odooModuleRoot, 'security', 'ir.model.access.csv');
    try {
        const accessCsvContent = (await vscode.workspace.fs.readFile(accessCsvUri)).toString();
        if (!accessCsvContent.includes(modelId)) {
            const lineIndex = fileContent.split('\n').findIndex(line => line.includes('_name'));
            const range = document.lineAt(lineIndex > 0 ? lineIndex : 0).range;
            problems.push(new vscode.Diagnostic(range, `El modelo '${modelName}' no tiene reglas de acceso definidas en security/ir.model.access.csv.`, vscode.DiagnosticSeverity.Warning));
        }
    } catch {
        const lineIndex = fileContent.split('\n').findIndex(line => line.includes('_name'));
        const range = document.lineAt(lineIndex > 0 ? lineIndex : 0).range;
        problems.push(new vscode.Diagnostic(range, `El archivo security/ir.model.access.csv no existe en este módulo.`, vscode.DiagnosticSeverity.Warning));
    }
}

/**
 * @param {vscode.Uri} fileUri
 * @returns {Promise<vscode.Uri|null>}
 */
async function findOdooModuleRoot(fileUri) {
    let currentDir = vscode.Uri.joinPath(fileUri, '..');
    for (let i = 0; i < 10; i++) {
        const manifestUri = vscode.Uri.joinPath(currentDir, '__manifest__.py');
        try {
            await vscode.workspace.fs.stat(manifestUri);
            return currentDir;
        } catch {
            const parentDir = vscode.Uri.joinPath(currentDir, '..');
            if (parentDir.fsPath === currentDir.fsPath) return null;
            currentDir = parentDir;
        }
    }
    return null;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

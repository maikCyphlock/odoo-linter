import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const diagnostics = vscode.languages.createDiagnosticCollection("odoo-linter");
    context.subscriptions.push(diagnostics);

    // Lint document when it's opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => updateDiagnostics(document, diagnostics))
    );

    // Lint document when it's saved
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => updateDiagnostics(document, diagnostics))
    );

    // Lint currently active document
    if (vscode.window.activeTextEditor) {
        updateDiagnostics(vscode.window.activeTextEditor.document, diagnostics);
    }
}

async function updateDiagnostics(document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection): Promise<void> {
    if (document.languageId !== 'python' && document.languageId !== 'xml') {
        return;
    }

    const odooModuleRoot = await findOdooModuleRoot(document.uri);
    if (!odooModuleRoot) {
        // Not in an Odoo module, clear diagnostics and return
        diagnostics.set(document.uri, []);
        return;
    }

    const problems: vscode.Diagnostic[] = [];

    if (document.languageId === 'python') {
        await lintPythonFile(document, odooModuleRoot, problems);
    } else if (document.languageId === 'xml') {
        // I forgot to add this call before
        await lintDataFile(document, odooModuleRoot, problems);
    }

    diagnostics.set(document.uri, problems);
}

async function lintDataFile(document: vscode.TextDocument, odooModuleRoot: vscode.Uri, problems: vscode.Diagnostic[]): Promise<void> {
    const manifestUri = vscode.Uri.joinPath(odooModuleRoot, '__manifest__.py');

    try {
        const manifestContent = (await vscode.workspace.fs.readFile(manifestUri)).toString();

        // A simple (and not foolproof) parser for the 'data' and 'demo' keys
        const dataRegex = /'data'\s*:\s*\[([^\]]*)\]/;
        const demoRegex = /'demo'\s*:\s*\[([^\]]*)\]/;

        const dataMatch = manifestContent.match(dataRegex);
        const demoMatch = manifestContent.match(demoRegex);

        const dataFiles = dataMatch ? dataMatch[1].split(',').map(f => f.trim().replace(/['"]/g, '')) : [];
        const demoFiles = demoMatch ? demoMatch[1].split(',').map(f => f.trim().replace(/['"]/g, '')) : [];

        const relativePath = document.uri.fsPath.substring(odooModuleRoot.fsPath.length + 1).replace(/\\/g, '/');

        if (!dataFiles.includes(relativePath) && !demoFiles.includes(relativePath)) {
            problems.push({
                code: '',
                message: `El archivo no está declarado en la clave 'data' o 'demo' del __manifest__.py.`,
                range: new vscode.Range(0, 0, 0, 1),
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    } catch (error) {
        console.error("Error linting data file:", error);
    }
}

async function lintPythonFile(document: vscode.TextDocument, odooModuleRoot: vscode.Uri, problems: vscode.Diagnostic[]): Promise<void> {
    const fileName = document.uri.fsPath.split('/').pop()?.split('\\').pop();
    if (!fileName) {
        return;
    }

    // 1. Check for import in __init__.py
    if (fileName !== '__init__.py') {
        const dirUri = vscode.Uri.joinPath(document.uri, '..');
        const initPyUri = vscode.Uri.joinPath(dirUri, '__init__.py');
        try {
            const initPyContent = (await vscode.workspace.fs.readFile(initPyUri)).toString();
            const moduleName = fileName.replace('.py', '');

            const importPattern = new RegExp(`from\\s+\\.\\s+import\\s+${moduleName}`);
            if (!importPattern.test(initPyContent)) {
                problems.push({
                    code: '',
                    message: `El archivo no está importado en el __init__.py del directorio.`,
                    range: new vscode.Range(0, 0, 0, 1),
                    severity: vscode.DiagnosticSeverity.Warning,
                    source: 'odoo-linter',
                });
            }
        } catch {
            // __init__.py not found, we don't flag this for now.
        }
    }

    // 2. Check for model access rules
    const fileContent = document.getText();
    if (fileContent.includes('models.Model')) {
        await lintModelAccess(document, odooModuleRoot, problems, fileContent);
    }
}

async function lintModelAccess(document: vscode.TextDocument, odooModuleRoot: vscode.Uri, problems: vscode.Diagnostic[], fileContent: string): Promise<void> {
    const nameMatch = fileContent.match(/_name\s*=\s*['"]([^'"]+)['"]/);
    if (!nameMatch || !nameMatch[1]) {
        // Could be a model, but no _name found.
        return;
    }
    const modelName = nameMatch[1];
    const modelId = `model_${modelName.replace(/\./g, '_')}`;

    const accessCsvUri = vscode.Uri.joinPath(odooModuleRoot, 'security', 'ir.model.access.csv');
    try {
        const accessCsvContent = (await vscode.workspace.fs.readFile(accessCsvUri)).toString();

        const lines = accessCsvContent.split('\n');
        const modelAccessExists = lines.some(line => line.includes(modelId));

        if (!modelAccessExists) {
            const lineIndex = document.getText().split('\n').findIndex(line => line.includes('_name'));
            const range = new vscode.Range(lineIndex > 0 ? lineIndex : 0, 0, lineIndex > 0 ? lineIndex : 0, 100);

            problems.push({
                code: '',
                message: `El modelo '${modelName}' no tiene reglas de acceso definidas en security/ir.model.access.csv.`,
                range: range,
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    } catch {
        // ir.model.access.csv doesn't exist.
        const lineIndex = fileContent.split('\n').findIndex(line => line.includes('_name'));
        problems.push({
            code: '',
            message: `El archivo security/ir.model.access.csv no existe en este módulo.`,
            range: new vscode.Range(lineIndex > 0 ? lineIndex : 0, 0, lineIndex > 0 ? lineIndex : 0, 100),
            severity: vscode.DiagnosticSeverity.Warning,
            source: 'odoo-linter',
        });
    }
}
async function findOdooModuleRoot(fileUri: vscode.Uri): Promise<vscode.Uri | null> {
    let currentDir = vscode.Uri.joinPath(fileUri, '..');

    // Check up to 10 levels up
    for (let i = 0; i < 10; i++) {
        try {
            const manifestUri = vscode.Uri.joinPath(currentDir, '__manifest__.py');
            await vscode.workspace.fs.stat(manifestUri);
            return currentDir; // Found it
        } catch {
            // Not found, go one level up
            const parentDir = vscode.Uri.joinPath(currentDir, '..');
            if (parentDir.fsPath === currentDir.fsPath) {
                // Reached the root of the filesystem
                return null;
            }
            currentDir = parentDir;
        }
    }

    return null; // Limit reached
}

export function deactivate() {}

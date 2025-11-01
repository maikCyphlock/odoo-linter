import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const diagnostics = vscode.languages.createDiagnosticCollection("odoo-linter");
    context.subscriptions.push(diagnostics);

    let lintingTimeout: NodeJS.Timeout;

    const triggerLinting = (document: vscode.TextDocument) => {
        clearTimeout(lintingTimeout);
        lintingTimeout = setTimeout(() => {
            updateDiagnostics(document, diagnostics);
        }, 500); // 500ms debounce
    };

    // Lint document when it's opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => triggerLinting(document))
    );

    // Lint document when it's saved
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => triggerLinting(document))
    );

    // Lint document when its content changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => triggerLinting(event.document))
    );

    // Lint when the active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                triggerLinting(editor.document);
            }
        })
    );

    // Lint the active document initially
    if (vscode.window.activeTextEditor) {
        triggerLinting(vscode.window.activeTextEditor.document);
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
    const fileContent = document.getText();
    const lines = fileContent.split('\n');

    // Check XML structure
    if (!fileContent.includes('<?xml')) {
        problems.push({
            code: '',
            message: 'El archivo XML debe comenzar con la declaración <?xml version="1.0" encoding="utf-8"?>',
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Warning,
            source: 'odoo-linter',
        });
    } else {
        // Check encoding
        const xmlDeclaration = fileContent.match(/<\?xml[^?]*\?>/)?.[0] || '';
        if (!xmlDeclaration.includes('encoding="utf-8"') && !xmlDeclaration.includes("encoding='utf-8'")) {
            problems.push({
                code: '',
                message: 'El archivo XML debe usar encoding="utf-8"',
                range: new vscode.Range(0, 0, 0, xmlDeclaration.length),
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    }

    // Check for root element <odoo>
    if (!fileContent.includes('<odoo>') && !fileContent.includes('<openerp>')) {
        problems.push({
            code: '',
            message: 'El archivo XML debe tener un elemento raíz <odoo>',
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
    }

    // Check for duplicate IDs in the file
    const idPattern = /id=["']([^"']+)["']/g;
    const ids: Map<string, number[]> = new Map();
    lines.forEach((line, index) => {
        let match;
        const regex = /id=["']([^"']+)["']/g;
        while ((match = regex.exec(line)) !== null) {
            const id = match[1];
            if (!ids.has(id)) {
                ids.set(id, []);
            }
            ids.get(id)!.push(index);
        }
    });

    // Report duplicate IDs
    ids.forEach((lineNumbers, id) => {
        if (lineNumbers.length > 1) {
            lineNumbers.forEach(lineNum => {
                problems.push({
                    code: '',
                    message: `ID duplicado '${id}' encontrado en el archivo`,
                    range: new vscode.Range(lineNum, 0, lineNum, lines[lineNum].length),
                    severity: vscode.DiagnosticSeverity.Error,
                    source: 'odoo-linter',
                });
            });
        }
    });

    // Check for model references
    const modelPattern = /model=["']([^"']+)["']/g;
    let modelMatch;
    lines.forEach((line, index) => {
        const regex = /model=["']([^"']+)["']/g;
        while ((modelMatch = regex.exec(line)) !== null) {
            const modelName = modelMatch[1];
            // Check if it's a common Odoo model pattern (contains dots)
            if (!modelName.includes('.')) {
                problems.push({
                    code: '',
                    message: `El modelo '${modelName}' no sigue la convención de nombres de Odoo (debe contener puntos, ej: res.partner)`,
                    range: new vscode.Range(index, modelMatch.index, index, modelMatch.index + modelMatch[0].length),
                    severity: vscode.DiagnosticSeverity.Warning,
                    source: 'odoo-linter',
                });
            }
        }
    });

    // Check if file is declared in manifest
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
    const lines = fileContent.split('\n');
    
    // Check for _name
    const nameMatch = fileContent.match(/_name\s*=\s*['"]([^'"]+)['"]/);
    if (!nameMatch || !nameMatch[1]) {
        // Could be a model, but no _name found.
        // Check if it's inheriting
        const inheritMatch = fileContent.match(/_inherit\s*=\s*['"]([^'"]+)['"]/);
        if (!inheritMatch) {
            const modelLineIndex = lines.findIndex(line => line.includes('models.Model'));
            if (modelLineIndex >= 0) {
                problems.push({
                    code: '',
                    message: 'El modelo debe tener un atributo _name o _inherit',
                    range: new vscode.Range(modelLineIndex, 0, modelLineIndex, lines[modelLineIndex].length),
                    severity: vscode.DiagnosticSeverity.Error,
                    source: 'odoo-linter',
                });
            }
        }
        return;
    }
    
    const modelName = nameMatch[1];
    const nameLineIndex = lines.findIndex(line => line.includes('_name'));
    
    // Check for _description
    const descriptionMatch = fileContent.match(/_description\s*=\s*['"]([^'"]+)['"]/);
    if (!descriptionMatch) {
        problems.push({
            code: '',
            message: `El modelo '${modelName}' debe tener un atributo _description`,
            range: new vscode.Range(nameLineIndex, 0, nameLineIndex, lines[nameLineIndex].length),
            severity: vscode.DiagnosticSeverity.Warning,
            source: 'odoo-linter',
        });
    }
    
    // Check if model name follows Odoo conventions
    if (!modelName.includes('.')) {
        problems.push({
            code: '',
            message: `El nombre del modelo '${modelName}' debe seguir la convención de Odoo (ej: mi_modulo.mi_modelo)`,
            range: new vscode.Range(nameLineIndex, 0, nameLineIndex, lines[nameLineIndex].length),
            severity: vscode.DiagnosticSeverity.Warning,
            source: 'odoo-linter',
        });
    }
    
    // Check for fields without string attribute
    const fieldPattern = /(\w+)\s*=\s*fields\.(\w+)\(([^)]*)\)/g;
    let fieldMatch;
    lines.forEach((line, index) => {
        const regex = /(\w+)\s*=\s*fields\.(\w+)\(([^)]*)\)/g;
        while ((fieldMatch = regex.exec(line)) !== null) {
            const fieldName = fieldMatch[1];
            const fieldType = fieldMatch[2];
            const fieldParams = fieldMatch[3];
            
            // Skip technical fields
            if (['id', 'create_date', 'create_uid', 'write_date', 'write_uid', '__last_update'].includes(fieldName)) {
                continue;
            }
            
            // Check if string parameter is present
            if (!fieldParams.includes('string=')) {
                problems.push({
                    code: '',
                    message: `El campo '${fieldName}' debe tener un parámetro 'string' descriptivo`,
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Information,
                    source: 'odoo-linter',
                });
            }
        }
    });
    
    // Check for access rules
    const modelId = `model_${modelName.replace(/\./g, '_')}`;
    const accessCsvUri = vscode.Uri.joinPath(odooModuleRoot, 'security', 'ir.model.access.csv');
    try {
        const accessCsvContent = (await vscode.workspace.fs.readFile(accessCsvUri)).toString();
        const accessLines = accessCsvContent.split('\n');
        const modelAccessExists = accessLines.some(line => line.includes(modelId));

        if (!modelAccessExists) {
            problems.push({
                code: '',
                message: `El modelo '${modelName}' no tiene reglas de acceso definidas en security/ir.model.access.csv.`,
                range: new vscode.Range(nameLineIndex, 0, nameLineIndex, lines[nameLineIndex].length),
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    } catch {
        // ir.model.access.csv doesn't exist.
        problems.push({
            code: '',
            message: `El archivo security/ir.model.access.csv no existe en este módulo.`,
            range: new vscode.Range(nameLineIndex, 0, nameLineIndex, lines[nameLineIndex].length),
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

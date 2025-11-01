const vscode = require('vscode');
const path = require('path');
const Parser = require('web-tree-sitter');

let pythonParser; // Will be initialized in activate()

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    // Initialize Tree-sitter parser
    await Parser.init();
    const parser = new Parser();
    const wasmPath = path.join(context.extensionPath, 'parsers', 'tree-sitter-python.wasm');
    try {
        const Python = await Parser.Language.load(wasmPath);
        parser.setLanguage(Python);
        pythonParser = parser;
        console.log("Odoo Linter: Parser de Python cargado exitosamente.");
    } catch (e) {
        console.error("Odoo Linter: Error cargando el parser de Python:", e);
    }

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

// --- LINTER RULES ---

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Uri} odooModuleRoot
 * @param {vscode.Diagnostic[]} problems
 */
async function lintPythonFile(document, odooModuleRoot, problems) {
    const fileName = path.basename(document.uri.fsPath);

    // Rule 1: Check __init__.py import (Regex based)
    if (fileName !== '__init__.py') {
        lintMissingInitImport(document, problems);
    }

    const fileContent = document.getText();

    // Rule 2: Check model access rules (Regex based)
    if (fileContent.includes('models.Model')) {
        lintMissingModelAccess(document, odooModuleRoot, problems, fileContent);
    }

    // Rule 3: Check for fields without 'string' attribute (Tree-sitter based)
    if (pythonParser) {
        lintFieldsWithoutString(document, problems, fileContent);
    }
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
            problems.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `El archivo no está declarado en la clave 'data' o 'demo' del __manifest__.py.`, vscode.DiagnosticSeverity.Warning));
        }
    } catch (error) {}
}

async function lintMissingInitImport(document, problems) {
    const fileName = path.basename(document.uri.fsPath);
    const dirUri = vscode.Uri.joinPath(document.uri, '..');
    const initPyUri = vscode.Uri.joinPath(dirUri, '__init__.py');
    const moduleName = fileName.replace('.py', '');
    const importPattern = new RegExp(`from\\s+\\.\\s+import\\s+${moduleName}`);

    try {
        const initPyContent = (await vscode.workspace.fs.readFile(initPyUri)).toString();
        if (!importPattern.test(initPyContent)) {
            problems.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `El archivo no está importado en el __init__.py del directorio.`, vscode.DiagnosticSeverity.Warning));
        }
    } catch (error) {}
}

async function lintMissingModelAccess(document, odooModuleRoot, problems, fileContent) {
    const nameMatch = fileContent.match(/_name\s*=\s*['"]([^'"]+)['"]/);
    if (!nameMatch || !nameMatch[1]) return;
    const modelName = nameMatch[1];
    const modelId = `model_${modelName.replace(/\./g, '_')}`;
    const accessCsvUri = vscode.Uri.joinPath(odooModuleRoot, 'security', 'ir.model.access.csv');
    try {
        const accessCsvContent = (await vscode.workspace.fs.readFile(accessCsvUri)).toString();
        if (!accessCsvContent.includes(modelId)) {
            const lineIndex = fileContent.split('\n').findIndex(line => line.includes('_name'));
            problems.push(new vscode.Diagnostic(document.lineAt(lineIndex > 0 ? lineIndex : 0).range, `El modelo '${modelName}' no tiene reglas de acceso definidas en security/ir.model.access.csv.`, vscode.DiagnosticSeverity.Warning));
        }
    } catch {
        const lineIndex = fileContent.split('\n').findIndex(line => line.includes('_name'));
        problems.push(new vscode.Diagnostic(document.lineAt(lineIndex > 0 ? lineIndex : 0).range, `El archivo security/ir.model.access.csv no existe en este módulo.`, vscode.DiagnosticSeverity.Warning));
    }
}

function lintFieldsWithoutString(document, problems, fileContent) {
    const tree = pythonParser.parse(fileContent);
    tree.rootNode.descendantsOfType('assignment').forEach((node) => {
        const rightSide = node.namedChild(1);
        if (rightSide && rightSide.type === 'call') {
            const functionNameNode = rightSide.namedChild(0);
            if (functionNameNode?.text.startsWith('fields.')) {
                const argumentsNode = rightSide.namedChild(1);
                let hasString = false;
                if (argumentsNode) {
                    for (const arg of argumentsNode.namedChildren) {
                        if (arg.type === 'keyword_argument' && arg.namedChild(0)?.text === 'string') {
                            hasString = true;
                            break;
                        }
                    }
                }
                if (!hasString) {
                    const range = new vscode.Range(node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column);
                    problems.push(new vscode.Diagnostic(range, `El campo '${node.namedChild(0)?.text}' debe tener un parámetro 'string' descriptivo.`, vscode.DiagnosticSeverity.Information));
                }
            }
        }
    });
}


// --- UTILITY FUNCTIONS ---

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

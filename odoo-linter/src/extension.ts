import * as vscode from 'vscode';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

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
    const fileContent = document.getText().trim();
    const lines = fileContent.split('\n');

    // ---
    // PASO 1: Validación básica del contenido
    // ---
    if (!fileContent) {
        problems.push({
            code: 'EMPTY_FILE',
            message: 'El archivo XML está vacío',
            range: new vscode.Range(0, 0, 0, 0),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
        return;
    }

    // Verificar que comience con declaración XML
    if (!fileContent.startsWith('<?xml')) {
        problems.push({
            code: 'MISSING_XML_DECLARATION',
            message: 'El archivo debe comenzar con la declaración XML (<?xml ... ?>)',
            range: new vscode.Range(0, 0, 0, 5),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
    }

    // Verificar declaración XML válida
    const xmlDeclarationMatch = fileContent.match(/^<\?xml[^>]+\?>/);
    if (xmlDeclarationMatch) {
        const declaration = xmlDeclarationMatch[0];
        if (!/encoding\s*=\s*["']utf-8["']/i.test(declaration)) {
            problems.push({
                code: 'INVALID_ENCODING',
                message: 'La codificación debe ser UTF-8',
                range: new vscode.Range(0, 0, 0, declaration.length),
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    }

    // ---
    // PASO 2: Validación de sintaxis XML
    // ---
    const validationResult = XMLValidator.validate(fileContent, {
        allowBooleanAttributes: true,  // Para soportar atributos booleanos como 'required'
        unpairedTags: ['br', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'command', 'embed', 'hr', 'keygen', 'param', 'source', 'track', 'wbr']
    });

    if (validationResult !== true) {
        const err = validationResult.err;
        const line = Math.max(0, (err.line || 1) - 1);
        const column = Math.max(0, err.col || 0);
        
        problems.push({
            code: err.code || 'XML_SYNTAX_ERROR',
            message: `Error de sintaxis XML: ${err.msg || 'Error desconocido'}`,
            range: new vscode.Range(line, column, line, column + 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
        // Si el XML está roto, no tiene sentido seguir
        return;
    }

    // ---
    // PASO 3: Parseo y revisión de estructura
    // ---
    interface ParsedXml {
        odoo?: any;
        openerp?: any;
        [key: string]: any;
    }
    
    let parsedXml: ParsedXml;
    try {
        const parser = new XMLParser({
            ignoreAttributes: false,
            isArray: (name, jpath, isLeafNode, isAttribute) => {
                // Especificar qué elementos pueden aparecer múltiples veces
                return ['record', 'menuitem', 'template', 'xpath', 'field', 'delete', 'data'].includes(name);
            },
            attributeNamePrefix: '@_',
            attributesGroupName: 'attributes',
            cdataPropName: 'cdata',
            commentPropName: 'comment',
            preserveOrder: true
        });
        
        parsedXml = parser.parse(fileContent);
    } catch (e: any) {
        // Si hay un error en el parseo pero pasó la validación, es probablemente un problema de estructura
        problems.push({
            code: 'XML_STRUCTURE_ERROR',
            message: `Error en la estructura del XML: ${e.message}`,
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
        return;
    }

    // ---
    // PASO 4: Validación de estructura específica de Odoo
    // ---
    if (!Array.isArray(parsedXml) || parsedXml.length === 0) {
        problems.push({
            code: 'INVALID_ROOT_STRUCTURE',
            message: 'El XML debe contener elementos válidos',
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
        return;
    }

    // Buscar el elemento raíz <odoo> o <openerp>
    const hasOdooRoot = parsedXml.some((node: any) => node.odoo || node.openerp);
    if (!hasOdooRoot) {
        problems.push({
            code: 'MISSING_ROOT_ELEMENT',
            message: 'El archivo XML debe tener un elemento raíz <odoo> o <openerp>',
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
    }

    // Comprobación de la declaración XML (sigue siendo chequeo de texto)
    if (!fileContent.trim().startsWith('<?xml')) {
        problems.push({
            code: 'XML_DECLARATION',
            message: 'El archivo XML debe comenzar con la declaración <?xml version="1.0" encoding="utf-8"?>',
            range: new vscode.Range(0, 0, 0, 5),
            severity: vscode.DiagnosticSeverity.Warning,
            source: 'odoo-linter',
        });
    } else {
        const xmlDeclaration = lines[0] || '';
        if (!xmlDeclaration.includes('encoding="utf-8"') && !xmlDeclaration.includes("encoding='utf-8'")) {
            problems.push({
                code: 'XML_ENCODING',
                message: 'El archivo XML debe usar encoding="utf-8"',
                range: new vscode.Range(0, 0, 0, xmlDeclaration.length),
                severity: vscode.DiagnosticSeverity.Warning,
                source: 'odoo-linter',
            });
        }
    }

    // Comprobación de raíz <odoo> (usando el parser)
    if (!('odoo' in parsedXml) && !('openerp' in parsedXml)) {
        problems.push({
            code: 'ROOT_TAG',
            message: 'El archivo XML debe tener un elemento raíz <odoo> o <openerp>',
            range: new vscode.Range(0, 0, 0, 1),
            severity: vscode.DiagnosticSeverity.Error,
            source: 'odoo-linter',
        });
    }

    // ---
    // PASO 3: Lógica de Odoo (Mantenemos la lógica de líneas para los 'Range')
    // ---

    // Check for duplicate IDs in the file
    const ids: Map<string, number[]> = new Map();
    lines.forEach((line, index) => {
        const regex = /id=["']([^"']+)["']/g;
        let match;
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
                    code: 'DUPLICATE_ID',
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

    // Check for views (ir.ui.view)
    await checkViewDefinitions(document, lines, problems);

    // Check for menuitem definitions
    await checkMenuItems(document, lines, problems);

    // Check for action definitions
    await checkActions(document, lines, problems);

    // Check for security file when models are referenced
    await checkSecurityFile(document, odooModuleRoot, lines, problems);

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

async function checkViewDefinitions(document: vscode.TextDocument, lines: string[], problems: vscode.Diagnostic[]): Promise<void> {
    const fileContent = document.getText();

    lines.forEach((line, index) => {
        if (line.includes('model="ir.ui.view"') || line.includes("model='ir.ui.view'")) {
            // Check if record has an id
            if (!line.includes('id=')) {
                // Check previous line for id (common pattern)
                let hasId = false;
                if (index > 0 && lines[index - 1].includes('id=')) {
                    hasId = true;
                }
                if (!hasId) {
                    problems.push({
                        code: '',
                        message: 'La vista (ir.ui.view) debe tener un atributo "id" único',
                        range: new vscode.Range(index, 0, index, line.length),
                        severity: vscode.DiagnosticSeverity.Error,
                        source: 'odoo-linter',
                    });
                }
            }

            // Find the complete record block
            const startIndex = index;
            let endIndex = index;
            for (let i = index + 1; i < lines.length; i++) {
                if (lines[i].includes('</record>')) {
                    endIndex = i;
                    break;
                }
            }

            const viewBlock = lines.slice(startIndex, endIndex + 1).join('\n');

            // Check if it's an inherited view
            const isInheritedView = viewBlock.includes('name="inherit_id"') || viewBlock.includes("name='inherit_id'");

            // For new views (not inherited), check required fields
            if (!isInheritedView) {
                // Check for model field
                if (!viewBlock.includes('name="model"') && !viewBlock.includes("name='model'")) {
                    problems.push({
                        code: '',
                        message: 'La vista debe tener un campo <field name="model"> especificando el modelo',
                        range: new vscode.Range(index, 0, index, line.length),
                        severity: vscode.DiagnosticSeverity.Error,
                        source: 'odoo-linter',
                    });
                }

                // Check for arch field
                if (!viewBlock.includes('name="arch"') && !viewBlock.includes("name='arch'")) {
                    problems.push({
                        code: '',
                        message: 'La vista debe tener un campo <field name="arch"> con la estructura de la vista',
                        range: new vscode.Range(index, 0, index, line.length),
                        severity: vscode.DiagnosticSeverity.Error,
                        source: 'odoo-linter',
                    });
                }
            } else {
                // For inherited views, check that inherit_id and arch are present
                if (!viewBlock.includes('name="arch"') && !viewBlock.includes("name='arch'")) {
                    problems.push({
                        code: '',
                        message: 'La vista heredada debe tener un campo <field name="arch"> con las modificaciones',
                        range: new vscode.Range(index, 0, index, line.length),
                        severity: vscode.DiagnosticSeverity.Warning,
                        source: 'odoo-linter',
                    });
                }
            }
        }
    });
}

async function checkMenuItems(document: vscode.TextDocument, lines: string[], problems: vscode.Diagnostic[]): Promise<void> {
    lines.forEach((line, index) => {
        if (line.includes('<menuitem')) {
            // Check if menuitem has required attributes
            if (!line.includes('id=')) {
                problems.push({
                    code: '',
                    message: 'El menuitem debe tener un atributo "id" único',
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Error,
                    source: 'odoo-linter',
                });
            }

            if (!line.includes('name=')) {
                problems.push({
                    code: '',
                    message: 'El menuitem debe tener un atributo "name" descriptivo',
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Warning,
                    source: 'odoo-linter',
                });
            }
        }
    });
}

async function checkActions(document: vscode.TextDocument, lines: string[], problems: vscode.Diagnostic[]): Promise<void> {
    lines.forEach((line, index) => {
        // Check for action records (ir.actions.act_window)
        if (line.includes('model="ir.actions.act_window"') || line.includes("model='ir.actions.act_window'")) {
            // Check for required fields in action
            const startIndex = index;
            let endIndex = index;
            for (let i = index + 1; i < lines.length; i++) {
                if (lines[i].includes('</record>')) {
                    endIndex = i;
                    break;
                }
            }

            const actionBlock = lines.slice(startIndex, endIndex + 1).join('\n');

            // Check for name field
            if (!actionBlock.includes('name="name"') && !actionBlock.includes("name='name'")) {
                problems.push({
                    code: '',
                    message: 'La acción debe tener un campo <field name="name">',
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Warning,
                    source: 'odoo-linter',
                });
            }

            // Check for res_model field
            if (!actionBlock.includes('name="res_model"') && !actionBlock.includes("name='res_model'")) {
                problems.push({
                    code: '',
                    message: 'La acción debe tener un campo <field name="res_model"> especificando el modelo',
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Error,
                    source: 'odoo-linter',
                });
            }

            // Check for view_mode field
            if (!actionBlock.includes('name="view_mode"') && !actionBlock.includes("name='view_mode'")) {
                problems.push({
                    code: '',
                    message: 'La acción debe tener un campo <field name="view_mode"> (ej: tree,form)',
                    range: new vscode.Range(index, 0, index, line.length),
                    severity: vscode.DiagnosticSeverity.Warning,
                    source: 'odoo-linter',
                });
            }
        }
    });
}

async function checkSecurityFile(document: vscode.TextDocument, odooModuleRoot: vscode.Uri, lines: string[], problems: vscode.Diagnostic[]): Promise<void> {
    // Only check security files for views directory, not for every XML file
    const relativePath = document.uri.fsPath.substring(odooModuleRoot.fsPath.length + 1);
    
    // Skip security check for files in security, data, or demo directories
    if (relativePath.startsWith('security/') || relativePath.startsWith('data/') || relativePath.startsWith('demo/')) {
        return;
    }
    
    const fileContent = document.getText();
    
    // Only check if there are actual model definitions (not just references)
    const hasNewViews = fileContent.includes('model="ir.ui.view"') || fileContent.includes("model='ir.ui.view'");
    
    if (hasNewViews) {
        // Check if security directory exists
        const securityDirUri = vscode.Uri.joinPath(odooModuleRoot, 'security');
        try {
            await vscode.workspace.fs.stat(securityDirUri);
            
            // Check if ir.model.access.csv exists
            const accessCsvUri = vscode.Uri.joinPath(securityDirUri, 'ir.model.access.csv');
            try {
                await vscode.workspace.fs.stat(accessCsvUri);
            } catch {
                // Only warn, don't error - some modules might not need access rules
                // This is just a reminder
            }
        } catch {
            // Security directory doesn't exist - only inform for views directory
            if (relativePath.startsWith('views/')) {
                problems.push({
                    code: '',
                    message: 'Considera crear el directorio security/ con ir.model.access.csv para definir permisos',
                    range: new vscode.Range(0, 0, 0, 1),
                    severity: vscode.DiagnosticSeverity.Information,
                    source: 'odoo-linter',
                });
            }
        }
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

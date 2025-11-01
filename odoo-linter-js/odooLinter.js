const vscode = require('vscode');

class OdooLinter {
    constructor(parser, vscode) {
        this.parser = parser;
        this.vscode = vscode;
    }

    async lintDocument(document) {
        const diagnostics = [];
        const text = document.getText();

        // Skip empty files
        if (!text.trim()) {
            return [];
        }

        try {
            const tree = this.parser.parse(text);
            if (!tree) {
                return [];
            }

            const fileName = document.uri.fsPath;

            if (fileName.includes('/models/') && fileName.endsWith('__init__.py')) {
                await this.checkModelImports(diagnostics, document, tree);
            } else if (fileName.endsWith('__manifest__.py')) {
                await this.checkManifest(diagnostics, document, tree);
            } else if (fileName.endsWith('.py')) {
                // Check for unused imports
                this.checkUnusedImports(diagnostics, document, tree);
                // Check for Odoo model rules
                this.checkOdooModels(diagnostics, document, tree);
            }

            return diagnostics;

        } catch (error) {
            console.error('Error parsing document:', error);
            return [];
        }
    }

    async checkModelImports(diagnostics, document, tree) {
        const initUri = document.uri;
        const modelsDirUri = this.vscode.Uri.joinPath(initUri, '..');
    
        // 1. Get all python files in the models directory
        const allFiles = await this.vscode.workspace.fs.readDirectory(modelsDirUri);
        const pythonFiles = allFiles
            .filter(([fileName, fileType]) => fileType === this.vscode.FileType.File && fileName.endsWith('.py') && fileName !== '__init__.py')
            .map(([fileName, fileType]) => fileName.replace('.py', ''));
    
        // 2. Get all imported modules from the __init__.py file
        const importedModules = new Set();
        const importNodes = this.getNodesByType(tree.rootNode, 'import_from_statement');
        for (const importNode of importNodes) {
            // looking for `from . import my_module`
            const moduleNameNode = importNode.childForFieldName('module_name');
            if (moduleNameNode && moduleNameNode.text === '.') {
                const importList = importNode.childForFieldName('name');
                if (importList) {
                    for (const importName of importList.namedChildren) {
                        importedModules.add(importName.text);
                    }
                }
            }
        }
    
        // 3. Find the difference
        const notImportedFiles = pythonFiles.filter(fileName => !importedModules.has(fileName));
    
        // 4. Create diagnostics for each non-imported file
        if (notImportedFiles.length > 0) {
            const range = new this.vscode.Range(0, 0, 0, 10); // Report at the top of the file
            diagnostics.push(new this.vscode.Diagnostic(
                range,
                `The following models are not imported in __init__.py: ${notImportedFiles.join(', ')}`,
                this.vscode.DiagnosticSeverity.Warning
            ));
        }
    }

    async checkManifest(diagnostics, document, tree) {
        const dictNodes = this.getNodesByType(tree.rootNode, 'dictionary');
        if (dictNodes.length === 0) {
            return;
        }
        const dictNode = dictNodes[0];
    
        const manifest = new Map();
        const pairNodes = this.getNodesByType(dictNode, 'pair');
        for (const pairNode of pairNodes) {
            const keyNode = pairNode.childForFieldName('key');
            const valueNode = pairNode.childForFieldName('value');
            if (keyNode && valueNode) {
                manifest.set(keyNode.text.replace(/['"]/g, ''), { value: valueNode, node: valueNode });
            }
        }
    
        // Check for required keys
        const requiredKeys = ['name', 'version'];
        for (const key of requiredKeys) {
            if (!manifest.has(key)) {
                const range = new this.vscode.Range(
                    dictNode.startPosition.row,
                    dictNode.startPosition.column,
                    dictNode.endPosition.row,
                    dictNode.endPosition.column
                );
                diagnostics.push(new this.vscode.Diagnostic(
                    range,
                    `The module manifest is missing the '${key}' key.`,
                    this.vscode.DiagnosticSeverity.Warning
                ));
            }
        }
    
        // Check author
        if (manifest.has('author') && manifest.get('author').value.text.includes('Odoo S.A.')) {
            const authorNode = manifest.get('author').node;
            const range = new this.vscode.Range(
                authorNode.startPosition.row,
                authorNode.startPosition.column,
                authorNode.endPosition.row,
                authorNode.endPosition.column
            );
            diagnostics.push(new this.vscode.Diagnostic(
                range,
                `Module author is 'Odoo S.A.'. Consider changing it to your name or company.`,
                this.vscode.DiagnosticSeverity.Warning
            ));
        }
    
        // Check license
        if (!manifest.has('license')) {
            const range = new this.vscode.Range(
                dictNode.startPosition.row,
                dictNode.startPosition.column,
                dictNode.endPosition.row,
                dictNode.endPosition.column
            );
            diagnostics.push(new this.vscode.Diagnostic(
                range,
                `The module manifest is missing the 'license' key.`,
                this.vscode.DiagnosticSeverity.Warning
            ));
        } else {
            const license = manifest.get('license');
            const validLicenses = ["'LGPL-3'", "'AGPL-3'", "'OEEL-1'", "'OPL-1'", "'Other OSI approved licence'"];
            if (!validLicenses.includes(license.value.text)) {
                const range = new this.vscode.Range(
                    license.node.startPosition.row,
                    license.node.startPosition.column,
                    license.node.endPosition.row,
                    license.node.endPosition.column
                );
                diagnostics.push(new this.vscode.Diagnostic(
                    range,
                    `Invalid license ${license.value.text}. Recommended licenses are LGPL-3, AGPL-3, OEEL-1, OPL-1.`,
                    this.vscode.DiagnosticSeverity.Warning
                ));
            }
        }
    
        // Check views in manifest
        const manifestUri = document.uri;
        const moduleDirUri = this.vscode.Uri.joinPath(manifestUri, '..');
        const viewsDirUri = this.vscode.Uri.joinPath(moduleDirUri, 'views');
    
        try {
            const viewsDirFiles = await this.vscode.workspace.fs.readDirectory(viewsDirUri);
            const xmlFilesOnDisk = viewsDirFiles
                .filter(([fileName, fileType]) => fileType === this.vscode.FileType.File && fileName.endsWith('.xml'))
                .map(([fileName, fileType]) => `views/${fileName}`);
    
            let dataKeyNode = null;
            if (manifest.has('data')) {
                dataKeyNode = manifest.get('data').node;
            } else if (manifest.has('views')) {
                dataKeyNode = manifest.get('views').node;
            }
    
            if (dataKeyNode) {
                const manifestFiles = [];
                if (dataKeyNode.type === 'list') {
                    for (const child of dataKeyNode.namedChildren) {
                        if (child.type === 'string') {
                            manifestFiles.push(child.text.replace(/['"]/g, ''));
                        }
                    }
                }
    
                const notInManifest = xmlFilesOnDisk.filter(file => !manifestFiles.includes(file));
    
                if (notInManifest.length > 0) {
                    const range = new this.vscode.Range(
                        dataKeyNode.startPosition.row,
                        dataKeyNode.startPosition.column,
                        dataKeyNode.endPosition.row,
                        dataKeyNode.endPosition.column
                    );
                    diagnostics.push(new this.vscode.Diagnostic(
                        range,
                        `The following view files are not declared in the manifest: ${notInManifest.join(', ')}`,
                        this.vscode.DiagnosticSeverity.Warning
                    ));
                }
            } else if (xmlFilesOnDisk.length > 0) {
                // has xml files but no data/views key
                const range = new this.vscode.Range(
                    dictNode.startPosition.row,
                    dictNode.startPosition.column,
                    dictNode.endPosition.row,
                    dictNode.endPosition.column
                );
                diagnostics.push(new this.vscode.Diagnostic(
                    range,
                    `The manifest is missing the 'data' key to declare view files.`,
                    this.vscode.DiagnosticSeverity.Warning
                ));
            }
        } catch (error) {
            if (!(error instanceof this.vscode.FileSystemError && error.code === 'FileNotFound')) {
                console.error("Error checking views directory:", error);
            }
        }
    }

    checkOdooModels(diagnostics, document, tree) {
        const classNodes = this.getNodesByType(tree.rootNode, 'class_definition');
        for (const classNode of classNodes) {
            const superclassesNode = classNode.childForFieldName('superclasses');
            if (superclassesNode) {
                let isOdooModel = false;
                for (const child of superclassesNode.namedChildren) {
                    if (child.text === 'models.Model' || child.text === 'models.TransientModel') {
                        isOdooModel = true;
                        break;
                    }
                }
    
                if (isOdooModel) {
                    // This is an Odoo model
                    const bodyNode = classNode.childForFieldName('body');
                    let hasNameAttribute = false;
                    if (bodyNode) {
                        const assignmentNodes = this.getNodesByType(bodyNode, 'assignment');
                        for (const assignmentNode of assignmentNodes) {
                            const leftNode = assignmentNode.childForFieldName('left');
                            if (leftNode && leftNode.text === '_name') {
                                hasNameAttribute = true;
                                break;
                            }
                        }
                    }
    
                    if (!hasNameAttribute) {
                        const classNameNode = classNode.childForFieldName('name');
                        const range = new vscode.Range(
                            classNameNode.startPosition.row,
                            classNameNode.startPosition.column,
                            classNameNode.endPosition.row,
                            classNameNode.endPosition.column
                        );
                        diagnostics.push(new vscode.Diagnostic(
                            range,
                            `Odoo model '${classNameNode.text}' is missing '_name' attribute.`,
                            vscode.DiagnosticSeverity.Warning
                        ));
                    }
                }
            }
        }
    }

    checkUnusedImports(diagnostics, document, tree) {
        const importNodes = this.getNodesByType(tree.rootNode, 'import_statement', 'import_from_statement');
        const nameNodes = this.getNodesByType(tree.rootNode, 'identifier');

        // Extract all imported names
        const importedNames = new Map();

        for (const node of importNodes) {
            if (node.type === 'import_statement') {
                // Handle 'import x' or 'import x as y'
                const importClause = node.firstChild;
                if (importClause && importClause.type === 'dotted_name') {
                    const name = importClause.text;
                    const aliasNode = importClause.nextSibling;
                    const alias = aliasNode && aliasNode.type === 'as' ?
                        aliasNode.nextSibling?.text : name.split('.').pop();

                    if (alias) {
                        importedNames.set(alias, {
                            node: importClause,
                            used: false
                        });
                    }
                }
            } else if (node.type === 'import_from_statement') {
                // Handle 'from x import y'
                const importList = node.childForFieldName('names');
                if (importList) {
                    importList.namedChildren.forEach(importName => {
                        if (importName.type === 'import_from_as_name') {
                            const name = importName.firstChild.text;
                            const aliasNode = importName.childForFieldName('alias');
                            const alias = aliasNode ? aliasNode.text : name;

                            if (alias) {
                                importedNames.set(alias, {
                                    node: importName,
                                    used: false
                                });
                            }
                        }
                    });
                }
            }
        }

        // Check which imports are used
        for (const nameNode of nameNodes) {
            // Skip if this is part of an import statement
            if (this.isPartOfImport(nameNode)) {
                continue;
            }

            const name = nameNode.text;
            if (importedNames.has(name)) {
                importedNames.get(name).used = true;
            }
        }

        // Create diagnostics for unused imports
        for (const [name, {
                node,
                used
            }] of importedNames.entries()) {
            if (!used) {
                const range = new vscode.Range(
                    node.startPosition.row,
                    node.startPosition.column,
                    node.endPosition.row,
                    node.endPosition.column
                );

                diagnostics.push(new vscode.Diagnostic(
                    range,
                    `'${name}' is imported but unused`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }
    }

    isPartOfImport(node) {
        // Check if this is part of an import statement
        let parent = node.parent;
        while (parent) {
            if (parent.type === 'import_statement' || parent.type === 'import_from_statement') {
                return true;
            }
            parent = parent.parent;
        }
        return false;
    }

    getNodesByType(node, ...types) {
        let results = [];

        if (types.includes(node.type)) {
            results.push(node);
        }

        for (const child of node.children || []) {
            results = results.concat(this.getNodesByType(child, ...types));
        }

        return results;
    }
}

module.exports = OdooLinter;

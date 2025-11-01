const vscode = require('vscode');

class OdooLinter {
    constructor(parser) {
        this.parser = parser;
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

            if (fileName.endsWith('__manifest__.py')) {
                this.checkManifest(diagnostics, document, tree);
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

    checkManifest(diagnostics, document, tree) {
        const dictNodes = this.getNodesByType(tree.rootNode, 'dictionary');
        if (dictNodes.length > 0) {
            const dictNode = dictNodes[0]; // Assuming one manifest dict per file
            const pairNodes = this.getNodesByType(dictNode, 'pair');
            let hasLicense = false;

            for (const pairNode of pairNodes) {
                const keyNode = pairNode.childForFieldName('key');
                if (!keyNode) continue;

                if (keyNode.text === "'author'" || keyNode.text === '"author"') {
                    const valueNode = pairNode.childForFieldName('value');
                    if (valueNode && valueNode.text.includes('Odoo S.A.')) {
                         const range = new vscode.Range(
                            valueNode.startPosition.row,
                            valueNode.startPosition.column,
                            valueNode.endPosition.row,
                            valueNode.endPosition.column
                        );
                        diagnostics.push(new vscode.Diagnostic(
                            range,
                            `Module author is 'Odoo S.A.'. Consider changing it to your name or company.`,
                            vscode.DiagnosticSeverity.Warning
                        ));
                    }
                } else if (keyNode.text === "'license'" || keyNode.text === '"license"') {
                    hasLicense = true;
                    const valueNode = pairNode.childForFieldName('value');
                    const validLicenses = ["'LGPL-3'", "'AGPL-3'", "'OEEL-1'", "'OPL-1'", "'Other OSI approved licence'"];
                    if (valueNode && !validLicenses.includes(valueNode.text)) {
                        const range = new vscode.Range(
                            valueNode.startPosition.row,
                            valueNode.startPosition.column,
                            valueNode.endPosition.row,
                            valueNode.endPosition.column
                        );
                        diagnostics.push(new vscode.Diagnostic(
                            range,
                            `Invalid license '${valueNode.text}'. Recommended licenses are LGPL-3, AGPL-3, OEEL-1, OPL-1.`,
                            vscode.DiagnosticSeverity.Warning
                        ));
                    }
                }
            }

            if (!hasLicense) {
                const range = new vscode.Range(
                    dictNode.startPosition.row,
                    dictNode.startPosition.column,
                    dictNode.endPosition.row,
                    dictNode.endPosition.column
                );
                diagnostics.push(new vscode.Diagnostic(
                    range,
                    `The module manifest is missing the 'license' key.`,
                    vscode.DiagnosticSeverity.Warning
                ));
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

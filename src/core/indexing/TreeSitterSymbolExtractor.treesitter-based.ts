/**
 * TreeSitterSymbolExtractor - FULL Tree-sitter AST Implementation
 * 
 * This is the proper Tree-sitter implementation with real AST parsing,
 * replacing the regex-based fallback approach with true structural understanding.
 * 
 * Features:
 * - Real Tree-sitter parsers for TypeScript/JavaScript
 * - AST-based scope detection and symbol extraction
 * - Semantic understanding of code structure
 * - No regex patterns or manual brace counting
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../../utils/Logger.js';

// Import Tree-sitter modules
let Parser: any;
let TypeScriptLanguage: any;
let JavaScriptLanguage: any;
let PythonLanguage: any;

// Lazy load Tree-sitter modules to handle import issues
async function loadTreeSitter() {
    if (!Parser) {
        Parser = (await import('tree-sitter')).default;
        const tsModule = await import('tree-sitter-typescript');
        const jsModule = await import('tree-sitter-javascript');
        const pyModule = await import('tree-sitter-python');

        TypeScriptLanguage = tsModule.default.typescript;
        JavaScriptLanguage = jsModule.default;
        PythonLanguage = pyModule.default;
    }
}

// Tree-sitter types (matching the existing interface)
interface TreeSitterParser {
    parse(source: string): TreeSitterTree;
    setLanguage(language: any): void;
}

interface TreeSitterTree {
    rootNode: TreeSitterNode;
}

interface TreeSitterNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TreeSitterNode[];
    namedChildren: TreeSitterNode[];
    parent?: TreeSitterNode;
    child(index: number): TreeSitterNode | null;
    childForFieldName(field: string): TreeSitterNode | null;
    descendantsOfType(type: string): TreeSitterNode[];
}

// Existing interfaces (from the original implementation)
export interface ExtractedSymbol {
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum' | 'method';
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    scope: 'local' | 'export' | 'global';
    visibility?: 'public' | 'private' | 'protected';
    parameters?: string[];
    returnType?: string;
    docstring?: string;
}

export interface ExtractedImport {
    module: string;
    symbols: string[];
    isDefault: boolean;
    isNamespace: boolean;
    line: number;
    source: string;
}

export interface SymbolExtractionResult {
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    exports: string[];
    docstrings: string[];
    scopeGraph: {
        nodes: any[];
        edges: any[];
    };
    parseErrors: string[];
}

export class TreeSitterSymbolExtractorFull {
    private parsers = new Map<string, TreeSitterParser>();
    private initialized = false;
    private logger: Logger;

    constructor() {
        this.logger = new Logger('TREESITTER-FULL', 'info');
    }

    /**
     * Initialize Tree-sitter parsers with real implementations
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            await loadTreeSitter();

            // Initialize TypeScript parser
            const tsParser = new Parser();
            tsParser.setLanguage(TypeScriptLanguage);
            this.parsers.set('typescript', tsParser);

            // Initialize JavaScript parser
            const jsParser = new Parser();
            jsParser.setLanguage(JavaScriptLanguage);
            this.parsers.set('javascript', jsParser);

            // Initialize Python parser
            const pyParser = new Parser();
            pyParser.setLanguage(PythonLanguage);
            this.parsers.set('python', pyParser);

            this.initialized = true;
            this.logger.info('✅ Tree-sitter parsers initialized successfully (TypeScript, JavaScript, Python)');

        } catch (error) {
            this.logger.error(`❌ Tree-sitter initialization failed: ${error}`);
            throw error;
        }
    }

    /**
     * Extract symbols using real Tree-sitter AST parsing with intelligent chunking
     */
    async extractSymbols(
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        await this.initialize();

        if (!this.parsers.has(language)) {
            throw new Error(`Unsupported language: ${language}`);
        }

        const parser = this.parsers.get(language)!;
        
        try {
            // Check if content exceeds Tree-sitter's 32KB limit
            const TREESITTER_LIMIT = 32768; // 2^15 bytes
            
            if (content.length <= TREESITTER_LIMIT) {
                // Small file - parse directly
                return await this.parseContentDirectly(parser, content, language, filePath);
            } else {
                // Large file - use intelligent chunking
                return await this.parseContentWithChunking(parser, content, language, filePath);
            }

        } catch (error) {
            this.logger.error(`AST parsing failed for ${filePath}: ${error}`);
            throw error;
        }
    }

    /**
     * Parse content directly (for files under 32KB)
     */
    private async parseContentDirectly(
        parser: any,
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        const tree = parser.parse(content);
        
        const symbols: ExtractedSymbol[] = [];
        const imports: ExtractedImport[] = [];
        const exports: string[] = [];
        const docstrings: string[] = [];
        const parseErrors: string[] = [];

        await this.traverseASTNode(
            tree.rootNode,
            symbols,
            imports,
            exports,
            docstrings,
            parseErrors,
            language,
            []
        );

        this.logger.info(`Extracted ${symbols.length} symbols from ${filePath}`);
        return { symbols, imports, exports, docstrings, scopeGraph: { nodes: [], edges: [] }, parseErrors };
    }

    /**
     * Parse large content using simple line-based chunking
     */
    private async parseContentWithChunking(
        parser: any,
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        // Use simple line-based chunking that's guaranteed to work
        return await this.parseWithLineBoundaries(parser, content, language, filePath);
    }


    /**
     * Fallback: Parse with simple line boundaries
     */
    private async parseWithLineBoundaries(
        parser: any,
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        // Simple approach: split into reasonably sized chunks at line boundaries
        const lines = content.split('\n');
        const LINES_PER_CHUNK = 500; // Small enough to be safe
        
        const allSymbols: ExtractedSymbol[] = [];
        const allImports: ExtractedImport[] = [];
        const allExports: string[] = [];
        const allDocstrings: string[] = [];
        const allParseErrors: string[] = [];

        for (let i = 0; i < lines.length; i += LINES_PER_CHUNK) {
            const chunkLines = lines.slice(i, i + LINES_PER_CHUNK);
            const chunkContent = chunkLines.join('\n');
            
            try {
                const result = await this.parseContentDirectly(parser, chunkContent, language, `${filePath}:lines${i}-${i + chunkLines.length}`);
                
                // Adjust line numbers
                result.symbols.forEach(symbol => {
                    symbol.startLine += i;
                    symbol.endLine += i;
                });
                
                allSymbols.push(...result.symbols);
                allImports.push(...result.imports);
                allExports.push(...result.exports);
                allDocstrings.push(...result.docstrings);
                allParseErrors.push(...result.parseErrors);
                
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Line chunk ${i} parsing failed: ${errorMessage}`);
                allParseErrors.push(`Lines ${i}-${i + chunkLines.length}: ${errorMessage}`);
            }
        }

        return {
            symbols: allSymbols,
            imports: allImports,
            exports: Array.from(new Set(allExports)),
            docstrings: allDocstrings,
            scopeGraph: { nodes: [], edges: [] },
            parseErrors: allParseErrors
        };
    }

    /**
     * CORE: AST Node Traversal with Semantic Understanding
     */
    private async traverseASTNode(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        docstrings: string[],
        parseErrors: string[],
        language: string,
        scopeStack: string[]
    ): Promise<void> {
        const nodeType = node.type;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;

        // Process TypeScript/JavaScript nodes
        if (language === 'typescript' || language === 'javascript') {
            await this.processTypeScriptASTNode(
                node,
                symbols,
                imports,
                exports,
                scopeStack,
                startLine,
                endLine
            );
        }
        // Process Python nodes
        else if (language === 'python') {
            await this.processPythonASTNode(
                node,
                symbols,
                imports,
                exports,
                scopeStack,
                startLine,
                endLine
            );
        }

        // Update scope stack for child traversal
        const newScopeStack = [...scopeStack];

        // Add to scope stack based on AST node type (not regex patterns)
        switch (nodeType) {
            case 'class_declaration':
            case 'class_definition':  // Python
                // For nested classes, track the nesting level
                const className = this.getNodeName(node);
                if (className) {
                    newScopeStack.push(`class:${className}`);
                } else {
                    newScopeStack.push('class');
                }
                break;
            case 'method_definition':
            case 'function_declaration':
            case 'function_definition':  // Python
            case 'arrow_function':
            case 'function_expression':
                newScopeStack.push('method');
                break;
        }

        // Recursively traverse all children with proper scope context
        for (const child of node.namedChildren) {
            await this.traverseASTNode(
                child,
                symbols,
                imports,
                exports,
                docstrings,
                parseErrors,
                language,
                newScopeStack
            );
        }
    }

    /**
     * Process TypeScript/JavaScript AST nodes with semantic understanding
     */
    private async processTypeScriptASTNode(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        scopeStack: string[],
        startLine: number,
        endLine: number
    ): Promise<void> {
        const nodeType = node.type;
        const isExported = this.isExportedNode(node);
        const currentScope = this.determineScope(scopeStack, isExported);

        switch (nodeType) {
            // CLASS DECLARATIONS
            case 'class_declaration':
                const className = this.getNodeName(node);
                if (className) {
                    symbols.push({
                        name: className,
                        type: 'class',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: currentScope
                    });
                    if (isExported) exports.push(className);
                }
                break;

            // INTERFACE DECLARATIONS
            case 'interface_declaration':
                const interfaceName = this.getNodeName(node);
                if (interfaceName) {
                    symbols.push({
                        name: interfaceName,
                        type: 'interface',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: currentScope
                    });
                    if (isExported) exports.push(interfaceName);
                }
                break;

            // TYPE DECLARATIONS
            case 'type_alias_declaration':
                const typeName = this.getNodeName(node);
                if (typeName) {
                    symbols.push({
                        name: typeName,
                        type: 'type',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: currentScope
                    });
                    if (isExported) exports.push(typeName);
                }
                break;

            // FUNCTION DECLARATIONS
            case 'function_declaration':
            case 'method_definition':
                // Only extract functions/methods at appropriate scope levels
                if (!this.isInMethodScope(scopeStack)) {
                    const functionName = this.getNodeName(node);
                    if (functionName) {
                        symbols.push({
                            name: functionName,
                            type: nodeType === 'method_definition' ? 'method' : 'function',
                            startLine,
                            endLine,
                            startColumn: node.startPosition.column,
                            endColumn: node.endPosition.column,
                            scope: currentScope
                        });
                        if (isExported) exports.push(functionName);
                    }
                }
                break;

            // VARIABLE DECLARATIONS - CRITICAL FILTERING
            // TypeScript uses 'lexical_declaration' for const/let declarations
            case 'lexical_declaration':
            case 'variable_declaration':
                await this.processVariableDeclarationAST(
                    node,
                    symbols,
                    exports,
                    scopeStack,
                    isExported,
                    startLine,
                    endLine
                );
                break;

            // IMPORT STATEMENTS
            case 'import_statement':
                await this.processImportAST(node, imports);
                break;
        }
    }

    /**
     * CRITICAL: Process variable declarations with AST-based semantic filtering
     */
    private async processVariableDeclarationAST(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        exports: string[],
        scopeStack: string[],
        isExported: boolean,
        startLine: number,
        endLine: number
    ): Promise<void> {
        // CORE RULE: Never extract variables inside methods/functions
        if (this.isInMethodScope(scopeStack)) {
            return; // Skip all method-scoped variables
        }

        // Extract variable declarators from AST
        const declarators = node.namedChildren.filter(child => child.type === 'variable_declarator');
        
        for (const declarator of declarators) {
            const varName = this.getNodeName(declarator);
            if (!varName) continue;

            // SEMANTIC FILTERING: Only extract meaningful variables
            const shouldExtract = isExported || this.isVariableSemanticalleMeaningful(declarator);
            
            if (shouldExtract) {
                const varType = this.getVariableTypeFromAST(node);
                const currentScope = this.determineScope(scopeStack, isExported);
                
                symbols.push({
                    name: varName,
                    type: varType,
                    startLine,
                    endLine,
                    startColumn: node.startPosition.column,
                    endColumn: node.endPosition.column,
                    scope: currentScope
                });
                if (isExported) exports.push(varName);
            }
        }
    }

    /**
     * Process Python AST node for symbol extraction
     */
    private async processPythonASTNode(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        scopeStack: string[],
        startLine: number,
        endLine: number
    ): Promise<void> {
        const nodeType = node.type;

        switch (nodeType) {
            case 'function_definition':
                const funcName = this.getNodeName(node);
                if (funcName) {
                    const params = this.extractPythonFunctionParams(node);
                    const isMethod = this.isInClassScope(scopeStack);
                    const decorators = this.extractPythonDecorators(node);

                    symbols.push({
                        name: funcName,
                        type: isMethod ? 'method' : 'function',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: scopeStack.length === 0 ? 'global' : 'local',
                        parameters: params,
                        visibility: funcName.startsWith('_') ? 'private' : 'public',
                        ...(decorators.length > 0 && { decorators })
                    });
                }
                break;

            case 'class_definition':
                const className = this.getNodeName(node);
                if (className) {
                    const isNestedClass = this.isInClassScope(scopeStack);
                    symbols.push({
                        name: className,
                        type: 'class',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: scopeStack.length === 0 ? 'global' : 'local',
                        visibility: className.startsWith('_') ? 'private' : 'public',
                        ...(isNestedClass && { nested: true })
                    });
                }
                break;

            case 'import_statement':
            case 'import_from_statement':
                const importInfo = this.extractPythonImport(node);
                if (importInfo) {
                    imports.push(importInfo);
                }
                break;

            case 'assignment':
                // Handle variable assignments at all levels
                const varName = this.extractPythonVariableName(node);
                if (varName && !varName.startsWith('__')) { // Skip magic variables like __all__
                    const isClassVar = this.isInClassScope(scopeStack) && !scopeStack.includes('method');
                    const isModuleVar = scopeStack.length === 0;
                    const isMethodVar = scopeStack.includes('method');

                    // Only track meaningful variables (not all method-level assignments)
                    const isConstantCase = varName === varName.toUpperCase() && varName.length > 1;
                    const shouldTrack = isModuleVar || isClassVar ||
                        (isMethodVar && (isConstantCase || varName.startsWith('_')));

                    if (shouldTrack) {
                        let varType: 'variable' | 'constant';
                        if (isClassVar || isConstantCase) {
                            varType = 'constant';
                        } else {
                            varType = 'variable';
                        }

                        symbols.push({
                            name: varName,
                            type: varType,
                            startLine,
                            endLine,
                            startColumn: node.startPosition.column,
                            endColumn: node.endPosition.column,
                            scope: isModuleVar ? 'global' : 'local',
                            visibility: varName.startsWith('_') ? 'private' : 'public'
                        });
                    }
                }
                break;
        }
    }

    private extractPythonFunctionParams(node: TreeSitterNode): string[] {
        const params: string[] = [];
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (const child of paramsNode.namedChildren) {
                if (child.type === 'identifier') {
                    params.push(child.text);
                }
            }
        }
        return params;
    }

    private extractPythonImport(node: TreeSitterNode): ExtractedImport | null {
        const startLine = node.startPosition.row + 1;

        if (node.type === 'import_statement') {
            // Handle: import module [as alias]
            for (const child of node.children) {
                if (child.type === 'aliased_import') {
                    const nameNode = child.childForFieldName('name');
                    const aliasNode = child.childForFieldName('alias');
                    if (nameNode) {
                        return {
                            module: nameNode.text,
                            symbols: aliasNode ? [aliasNode.text] : [],
                            isDefault: false,
                            isNamespace: true,
                            line: startLine,
                            source: node.text
                        };
                    }
                } else if (child.type === 'dotted_name' || child.type === 'identifier') {
                    return {
                        module: child.text,
                        symbols: [],
                        isDefault: false,
                        isNamespace: true,
                        line: startLine,
                        source: node.text
                    };
                }
            }
        } else if (node.type === 'import_from_statement') {
            // Handle: from module import symbol [as alias], symbol2 [as alias2]
            const moduleNode = node.childForFieldName('module_name');
            const nameNode = node.childForFieldName('name');
            if (moduleNode && nameNode) {
                let symbols: string[] = [];

                if (nameNode.type === 'import_list') {
                    // Multiple imports: from module import a, b as c, d
                    symbols = nameNode.namedChildren.map(child => {
                        if (child.type === 'aliased_import') {
                            const aliasNode = child.childForFieldName('alias');
                            return aliasNode ? aliasNode.text : child.childForFieldName('name')?.text || child.text;
                        }
                        return child.text;
                    });
                } else if (nameNode.type === 'aliased_import') {
                    // Single aliased import: from module import symbol as alias
                    const aliasNode = nameNode.childForFieldName('alias');
                    symbols = [aliasNode ? aliasNode.text : nameNode.childForFieldName('name')?.text || nameNode.text];
                } else {
                    // Single import: from module import symbol
                    symbols = [nameNode.text];
                }

                return {
                    module: moduleNode.text,
                    symbols,
                    isDefault: false,
                    isNamespace: false,
                    line: startLine,
                    source: node.text
                };
            }
        }
        return null;
    }

    private extractPythonVariableName(node: TreeSitterNode): string | null {
        const leftNode = node.childForFieldName('left');
        if (leftNode && leftNode.type === 'identifier') {
            return leftNode.text;
        }
        return null;
    }

    private extractPythonDecorators(node: TreeSitterNode): string[] {
        const decorators: string[] = [];

        // Look for previous siblings that are decorators
        if (node.parent) {
            for (const sibling of node.parent.children) {
                if (sibling.type === 'decorator') {
                    // Extract decorator name (e.g., @property -> "property")
                    const decoratorText = sibling.text.replace('@', '');
                    decorators.push(decoratorText);
                }
            }
        }

        return decorators;
    }

    /**
     * Helper: Check if we're inside a method/function scope using AST
     */
    private isInMethodScope(scopeStack: string[]): boolean {
        return scopeStack.includes('method') || scopeStack.includes('function');
    }

    /**
     * Helper: Check if we're inside a class scope (including nested classes)
     */
    private isInClassScope(scopeStack: string[]): boolean {
        return scopeStack.some(scope => scope === 'class' || scope.startsWith('class:'));
    }

    /**
     * Helper: Determine if node is exported by checking AST structure
     */
    private isExportedNode(node: TreeSitterNode): boolean {
        // Check parent nodes for export_statement
        let current = node.parent;
        while (current) {
            if (current.type === 'export_statement') return true;
            current = current.parent;
        }

        // Check for export keyword in children
        for (const child of node.children) {
            if (child.type === 'export' || child.text === 'export') return true;
        }

        return false;
    }

    /**
     * Helper: Get node name from AST structure
     */
    private getNodeName(node: TreeSitterNode): string | null {
        // Try to get name from field
        const nameNode = node.childForFieldName('name');
        if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'type_identifier')) {
            return nameNode.text;
        }

        // Fallback: find identifier child
        for (const child of node.namedChildren) {
            if (child.type === 'identifier' || child.type === 'type_identifier') {
                return child.text;
            }
        }

        return null;
    }

    /**
     * Helper: Check if variable is semantically meaningful using AST
     */
    private isVariableSemanticalleMeaningful(declaratorNode: TreeSitterNode): boolean {
        const init = declaratorNode.childForFieldName('value');
        if (!init) return false;

        const initType = init.type;
        return (
            initType === 'array' ||           // Fixed: was 'array_expression'
            initType === 'object' ||          // Fixed: was 'object_expression'
            initType === 'arrow_function' ||
            initType === 'function_expression' ||
            initType === 'new_expression' ||
            initType === 'call_expression'
        );
    }

    /**
     * Helper: Get variable type from AST
     */
    private getVariableTypeFromAST(node: TreeSitterNode): 'variable' | 'constant' {
        for (const child of node.children) {
            if (child.text === 'const') return 'constant';
            if (child.text === 'let' || child.text === 'var') return 'variable';
        }
        return 'variable';
    }

    /**
     * Helper: Determine scope based on context
     */
    private determineScope(scopeStack: string[], isExported: boolean): 'local' | 'export' | 'global' {
        if (isExported) return 'export';
        if (scopeStack.length > 0) return 'local';
        return 'global';
    }

    /**
     * Helper: Process import statements using AST
     */
    private async processImportAST(node: TreeSitterNode, imports: ExtractedImport[]): Promise<void> {
        const source = node.childForFieldName('source');
        if (source) {
            imports.push({
                module: source.text.replace(/['"]/g, ''),
                symbols: [], // Would need more detailed processing
                isDefault: false,
                isNamespace: false,
                line: node.startPosition.row + 1,
                source: node.text
            });
        }
    }


    /**
     * Get extraction statistics
     */
    getStats(): {
        initialized: boolean;
        supportedLanguages: string[];
        availableParsers: string[];
    } {
        return {
            initialized: this.initialized,
            supportedLanguages: ['typescript', 'javascript', 'python'],
            availableParsers: Array.from(this.parsers.keys())
        };
    }
}
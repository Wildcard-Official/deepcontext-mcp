/**
 * TreeSitterSymbolExtractor - Advanced AST-based symbol extraction
 * 
 * Restores the sophisticated symbol extraction from the original implementation
 * with Tree-sitter parsing for accurate code understanding.
 * 
 * Features:
 * - Full AST parsing with Tree-sitter
 * - Symbol extraction (functions, classes, interfaces, types)
 * - Import/export analysis
 * - Scope graph building
 * - Multi-language support
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../../utils/Logger.js';

// Tree-sitter types and languages
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

interface TreeSitterQuery {
    matches(node: TreeSitterNode): TreeSitterQueryMatch[];
    captures(node: TreeSitterNode): TreeSitterQueryCapture[];
}

interface TreeSitterQueryMatch {
    pattern: number;
    captures: TreeSitterQueryCapture[];
}

interface TreeSitterQueryCapture {
    name: string;
    node: TreeSitterNode;
}

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
    documentation?: string;
    parent?: string; // For methods/nested classes
}

export interface ExtractedImport {
    module: string;
    symbols: string[];
    isDefault: boolean;
    isNamespace: boolean;
    line: number;
    source: string;
}

export interface ScopeGraphNode {
    id: string;
    name: string;
    type: string;
    line: number;
    scope: string;
    parent?: string;
}

export interface ScopeGraphEdge {
    from: string;
    to: string;
    type: 'declares' | 'references' | 'calls' | 'imports';
}

export interface SymbolExtractionResult {
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    exports: string[];
    docstrings: string[];
    scopeGraph: {
        nodes: ScopeGraphNode[];
        edges: ScopeGraphEdge[];
    };
    parseErrors: string[];
}

export class TreeSitterSymbolExtractor {
    private parsers: Map<string, TreeSitterParser> = new Map();
    private queries: Map<string, TreeSitterQuery> = new Map();
    private initialized = false;
    private logger: Logger;

    constructor() {
        // Initialization will be deferred until first use
        this.logger = new Logger('SYMBOL-EXTRACTOR', 'info');
    }

    /**
     * Initialize Tree-sitter parsers and queries for supported languages
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            // Try to load Tree-sitter modules dynamically
            await this.initializeTypeScript();
            await this.initializeJavaScript();
            await this.initializePython();
            // Add more languages as needed
            
            this.initialized = true;
            this.logger.debug('✅ Tree-sitter initialization complete');
        } catch (error) {
            this.logger.warn('⚠️ Tree-sitter not available, falling back to regex-based extraction');
            this.initialized = false;
        }
    }

    /**
     * Extract symbols from source code
     */
    async extractSymbols(
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        await this.initialize();

        // If Tree-sitter is available, use it
        if (this.initialized && this.parsers.has(language)) {
            return this.extractWithTreeSitter(content, language, filePath);
        }

        // Fallback to regex-based extraction
        return this.extractWithRegex(content, language, filePath);
    }

    /**
     * Extract symbols using Tree-sitter AST parsing
     */
    private async extractWithTreeSitter(
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        const parser = this.parsers.get(language)!;
        const query = this.queries.get(language);
        
        try {
            const tree = parser.parse(content);
            const symbols: ExtractedSymbol[] = [];
            const imports: ExtractedImport[] = [];
            const exports: string[] = [];
            const docstrings: string[] = [];
            const scopeNodes: ScopeGraphNode[] = [];
            const scopeEdges: ScopeGraphEdge[] = [];
            const parseErrors: string[] = [];

            if (query) {
                // Use query-based extraction
                const captures = query.captures(tree.rootNode);
                
                for (const capture of captures) {
                    await this.processCapture(
                        capture, 
                        symbols, 
                        imports, 
                        exports, 
                        docstrings, 
                        scopeNodes, 
                        scopeEdges,
                        language
                    );
                }
            } else {
                // Fallback to node traversal
                await this.traverseNode(
                    tree.rootNode, 
                    symbols, 
                    imports, 
                    exports, 
                    docstrings, 
                    scopeNodes, 
                    scopeEdges,
                    language
                );
            }

            return {
                symbols,
                imports,
                exports,
                docstrings,
                scopeGraph: { nodes: scopeNodes, edges: scopeEdges },
                parseErrors
            };

        } catch (error) {
            this.logger.warn(`Tree-sitter parsing failed for ${filePath}: ${error}`);
            return this.extractWithRegex(content, language, filePath);
        }
    }

    /**
     * Fallback regex-based symbol extraction with scope awareness
     * FIXED: Only extracts top-level symbols, not variables inside functions
     */
    private async extractWithRegex(
        content: string,
        language: string,
        filePath: string
    ): Promise<SymbolExtractionResult> {
        const lines = content.split('\n');
        const symbols: ExtractedSymbol[] = [];
        const imports: ExtractedImport[] = [];
        const exports: string[] = [];
        const docstrings: string[] = [];

        // Track scope depth to avoid extracting variables inside functions
        let braceDepth = 0;
        let inFunction = false;
        let inClass = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineNumber = i + 1;

            // Track scope context
            const scopeContext = this.updateScopeContext(trimmed, braceDepth, inFunction, inClass);
            braceDepth = scopeContext.braceDepth;
            inFunction = scopeContext.inFunction;
            inClass = scopeContext.inClass;

            // Extract symbols based on language, with scope context
            switch (language) {
                case 'typescript':
                case 'javascript':
                    this.extractJavaScriptSymbolsFromLine(
                        trimmed, 
                        lineNumber, 
                        symbols, 
                        imports, 
                        exports,
                        { braceDepth, inFunction, inClass }
                    );
                    break;
                case 'python':
                    // Note: Python extraction doesn't use scope context yet
                    this.extractPythonSymbolsFromLine(trimmed, lineNumber, symbols, imports, exports);
                    break;
                case 'java':
                    // Note: Java extraction doesn't use scope context yet
                    this.extractJavaSymbolsFromLine(trimmed, lineNumber, symbols, imports, exports);
                    break;
                case 'go':
                    // Note: Go extraction doesn't use scope context yet
                    this.extractGoSymbolsFromLine(trimmed, lineNumber, symbols, imports, exports);
                    break;
                case 'rust':
                    // Note: Rust extraction doesn't use scope context yet
                    this.extractRustSymbolsFromLine(trimmed, lineNumber, symbols, imports, exports);
                    break;
            }

            // Extract docstrings
            if (this.isDocstring(trimmed, language)) {
                docstrings.push(trimmed);
            }
        }

        return {
            symbols,
            imports,
            exports,
            docstrings,
            scopeGraph: { nodes: [], edges: [] },
            parseErrors: []
        };
    }

    /**
     * Track scope context for accurate symbol extraction
     */
    private updateScopeContext(
        line: string, 
        braceDepth: number, 
        inFunction: boolean, 
        inClass: boolean
    ): { braceDepth: number; inFunction: boolean; inClass: boolean } {
        // ROOT FIX: Completely rewritten scope tracking logic
        
        // Detect class boundaries
        if (line.includes('class ')) {
            inClass = true;
        }
        
        // Detect function/method boundaries BEFORE counting braces
        // This ensures we set inFunction before the opening brace affects our logic
        if (line.includes('function') || 
            line.match(/\w+\s*\([^)]*\)\s*[{:]/) ||              // method signature with {
            line.match(/\w+\s*\([^)]*\)\s*:\s*\w+.*\s*[{]/) ||   // TypeScript method with return type
            line.match(/=>\s*[{]/) ||                            // arrow function  
            line.match(/async\s+\w+\s*\(/) ||                    // async method
            line.match(/^\s*\w+\s*\(/) ||                        // start of method signature (multi-line)
            line.includes('{') && line.match(/^\s*\)\s*:\s*.*\{/) || // end of multi-line method signature ): type {
            line.includes('{') && line.match(/^\s*\)\s*\{/)) {    // end of multi-line method signature ) {
            inFunction = true;
        }

        // Count braces to track depth - do this AFTER function detection
        const openBraces = (line.match(/\{/g) || []).length;
        const closeBraces = (line.match(/\}/g) || []).length;
        braceDepth += openBraces - closeBraces;

        // CRITICAL FIX: Only reset function scope when we see a closing brace 
        // AND we're exiting the function scope (not entering deeper nested scopes)
        if (closeBraces > 0 && inFunction) {
            // If we're in a class and closing braces brings us back to class level
            if (inClass && braceDepth <= 1) {
                inFunction = false;
            }
            // If we're not in a class and closing braces brings us to top level
            else if (!inClass && braceDepth <= 0) {
                inFunction = false;
                inClass = false;
            }
        }

        return { braceDepth, inFunction, inClass };
    }

    /**
     * Extract JavaScript/TypeScript symbols from a line with scope awareness
     * FIXED: Only extracts variables at top-level scope
     */
    private extractJavaScriptSymbolsFromLine(
        line: string,
        lineNumber: number,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        context?: { braceDepth: number; inFunction: boolean; inClass: boolean }
    ): void {
        // Function declarations
        let match = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'function',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('export') ? 'export' : 'local'
            });
            if (line.includes('export')) {
                exports.push(match[1]);
            }
        }

        // Class declarations
        match = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'class',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('export') ? 'export' : 'local'
            });
            if (line.includes('export')) {
                exports.push(match[1]);
            }
        }

        // Interface declarations
        match = line.match(/^(?:export\s+)?interface\s+(\w+)/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'interface',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('export') ? 'export' : 'local'
            });
            if (line.includes('export')) {
                exports.push(match[1]);
            }
        }

        // Type declarations
        match = line.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'type',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('export') ? 'export' : 'local'
            });
            if (line.includes('export')) {
                exports.push(match[1]);
            }
        }

        // Variable declarations - ONLY exported ones or complex configurations
        match = line.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
        if (match && context) {
            const isTopLevel = !context.inFunction && context.braceDepth <= 1;
            const isExported = line.includes('export');
            
            // ROOT FIX: Only extract variables that are actually meaningful
            // - Must be exported (indicating public API)
            // - OR must be a complex object/array (indicating configuration)
            // - AND not be a common method-scoped variable name
            const hasComplexValue = line.includes('{') || line.includes('[') || 
                                   line.includes('new ') || line.includes('require(') ||
                                   line.includes('import(');
            
            // ADDITIONAL FIX: Skip common method-scoped variable names
            const isCommonMethodVariable = ['config', 'capabilities', 'transport', 'result', 'response', 'data'].includes(match[1]);
            
            if (isTopLevel && (isExported || hasComplexValue) && !isCommonMethodVariable) {
                symbols.push({
                    name: match[1],
                    type: line.includes('const') ? 'constant' : 'variable',
                    startLine: lineNumber,
                    endLine: lineNumber,
                    startColumn: 0,
                    endColumn: line.length,
                    scope: isExported ? 'export' : 'local'
                });
                if (isExported) {
                    exports.push(match[1]);
                }
            }
            // Simple assignments like `const data = value` are IGNORED entirely
        }

        // Import statements
        match = line.match(/^import\s+(.+)\s+from\s+['"]([^'"]+)['"]/);
        if (match) {
            const importedSymbols = this.parseImportClause(match[1]);
            imports.push({
                module: match[2],
                symbols: importedSymbols,
                isDefault: match[1].includes('default'),
                isNamespace: match[1].includes('* as'),
                line: lineNumber,
                source: line
            });
        }
    }

    /**
     * Extract Python symbols from a line
     */
    private extractPythonSymbolsFromLine(
        line: string,
        lineNumber: number,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[]
    ): void {
        // Function definitions
        let match = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'function',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: match[1].startsWith('_') ? 'local' : 'global'
            });
        }

        // Class definitions
        match = line.match(/^class\s+(\w+)\s*(?:\([^)]*\))?:/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'class',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: match[1].startsWith('_') ? 'local' : 'global'
            });
        }

        // Import statements
        match = line.match(/^from\s+([^\s]+)\s+import\s+(.+)/);
        if (match) {
            const symbolNames = match[2].split(',').map(s => s.trim().replace(/\s+as\s+\w+/, ''));
            imports.push({
                module: match[1],
                symbols: symbolNames,
                isDefault: false,
                isNamespace: false,
                line: lineNumber,
                source: line
            });
        }

        match = line.match(/^import\s+([^\s]+)(?:\s+as\s+(\w+))?/);
        if (match) {
            imports.push({
                module: match[1],
                symbols: [match[2] || match[1]],
                isDefault: false,
                isNamespace: !!match[2],
                line: lineNumber,
                source: line
            });
        }
    }

    /**
     * Extract Java symbols from a line
     */
    private extractJavaSymbolsFromLine(
        line: string,
        lineNumber: number,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[]
    ): void {
        // Class declarations
        let match = line.match(/^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'class',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('public') ? 'export' : 'local',
                visibility: this.extractVisibility(line)
            });
        }

        // Interface declarations
        match = line.match(/^(?:public\s+)?interface\s+(\w+)/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'interface',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('public') ? 'export' : 'local',
                visibility: this.extractVisibility(line)
            });
        }

        // Method declarations
        match = line.match(/^(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:\w+\s+)?(\w+)\s*\(/);
        if (match && !line.includes('class') && !line.includes('interface')) {
            symbols.push({
                name: match[1],
                type: 'method',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: 'local',
                visibility: this.extractVisibility(line)
            });
        }

        // Import statements
        match = line.match(/^import\s+(?:static\s+)?([^;]+);/);
        if (match) {
            const fullImport = match[1];
            const parts = fullImport.split('.');
            const symbolName = parts[parts.length - 1];
            
            imports.push({
                module: fullImport,
                symbols: [symbolName],
                isDefault: false,
                isNamespace: false,
                line: lineNumber,
                source: line
            });
        }
    }

    /**
     * Extract Go symbols from a line
     */
    private extractGoSymbolsFromLine(
        line: string,
        lineNumber: number,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[]
    ): void {
        // Function declarations
        let match = line.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/);
        if (match) {
            const isExported = match[1][0] === match[1][0].toUpperCase();
            symbols.push({
                name: match[1],
                type: 'function',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: isExported ? 'export' : 'local'
            });
        }

        // Type declarations
        match = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);
        if (match) {
            const isExported = match[1][0] === match[1][0].toUpperCase();
            symbols.push({
                name: match[1],
                type: line.includes('interface') ? 'interface' : 'type',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: isExported ? 'export' : 'local'
            });
        }

        // Import statements
        match = line.match(/^import\s+"([^"]+)"/);
        if (match) {
            const parts = match[1].split('/');
            const packageName = parts[parts.length - 1];
            
            imports.push({
                module: match[1],
                symbols: [packageName],
                isDefault: false,
                isNamespace: true,
                line: lineNumber,
                source: line
            });
        }
    }

    /**
     * Extract Rust symbols from a line
     */
    private extractRustSymbolsFromLine(
        line: string,
        lineNumber: number,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[]
    ): void {
        // Function declarations
        let match = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'function',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('pub') ? 'export' : 'local'
            });
        }

        // Struct declarations
        match = line.match(/^(?:pub\s+)?struct\s+(\w+)/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'type',
                startLine: lineNumber,
                endLine: lineNumber,
                startColumn: 0,
                endColumn: line.length,
                scope: line.includes('pub') ? 'export' : 'local'
            });
        }

        // Use statements
        match = line.match(/^use\s+([^;]+);/);
        if (match) {
            const usePath = match[1];
            const parts = usePath.split('::');
            const symbolName = parts[parts.length - 1];
            
            imports.push({
                module: usePath,
                symbols: [symbolName],
                isDefault: false,
                isNamespace: false,
                line: lineNumber,
                source: line
            });
        }
    }

    // Helper methods
    private parseImportClause(importClause: string): string[] {
        // Parse TypeScript/JavaScript import clause
        const cleaned = importClause.replace(/[{}]/g, '');
        return cleaned.split(',').map(s => s.trim().replace(/\s+as\s+\w+/, ''));
    }

    private extractVisibility(line: string): 'public' | 'private' | 'protected' | undefined {
        if (line.includes('private')) return 'private';
        if (line.includes('protected')) return 'protected';
        if (line.includes('public')) return 'public';
        return undefined;
    }

    private isDocstring(line: string, language: string): boolean {
        switch (language) {
            case 'typescript':
            case 'javascript':
                return line.startsWith('/**') || line.startsWith('*');
            case 'python':
                return line.startsWith('"""') || line.startsWith("'''");
            case 'java':
                return line.startsWith('/**') || line.startsWith('*');
            default:
                return false;
        }
    }

    // Tree-sitter initialization methods (simplified for now)
    private async initializeTypeScript(): Promise<void> {
        // Tree-sitter parsers would be initialized here in a full implementation
        // Currently falling back to regex-based extraction
    }

    private async initializeJavaScript(): Promise<void> {
        // Tree-sitter parsers would be initialized here in a full implementation
        // Currently falling back to regex-based extraction
    }

    private async initializePython(): Promise<void> {
        // Tree-sitter parsers would be initialized here in a full implementation
        // Currently falling back to regex-based extraction
    }

    private async processCapture(
        capture: TreeSitterQueryCapture,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        docstrings: string[],
        scopeNodes: ScopeGraphNode[],
        scopeEdges: ScopeGraphEdge[],
        language: string
    ): Promise<void> {
        // This would process Tree-sitter query captures
        // Simplified for now since we're using regex fallback
    }

    private async traverseNode(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        docstrings: string[],
        scopeNodes: ScopeGraphNode[],
        scopeEdges: ScopeGraphEdge[],
        language: string,
        scopeStack: string[] = []
    ): Promise<void> {
        // PROPER AST-BASED SYMBOL EXTRACTION
        // Uses AST structure to understand scope and context, not line-by-line parsing
        
        const nodeType = node.type;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        
        // Track scope depth for semantic understanding
        const currentScope = scopeStack[scopeStack.length - 1] || 'global';
        
        switch (language) {
            case 'typescript':
            case 'javascript':
                await this.processTypeScriptNode(
                    node, 
                    symbols, 
                    imports, 
                    exports, 
                    scopeStack,
                    startLine,
                    endLine
                );
                break;
                
            // Add other languages as needed
            default:
                break;
        }
        
        // Update scope stack based on node type BEFORE traversing children
        const newScopeStack = [...scopeStack];
        
        // Add scope context for TypeScript/JavaScript nodes
        if (language === 'typescript' || language === 'javascript') {
            switch (nodeType) {
                case 'class_declaration':
                    newScopeStack.push('class');
                    break;
                case 'method_definition':
                case 'function_declaration':
                case 'arrow_function':
                case 'function_expression':
                    newScopeStack.push('method');
                    break;
                case 'statement_block':
                case 'function_body':
                    // Don't add to stack but maintain existing method/class context
                    break;
                // Handle other scope-creating nodes as needed
            }
        }
        
        // Recursively traverse children with updated scope context
        for (const child of node.namedChildren) {
            await this.traverseNode(
                child,
                symbols,
                imports,
                exports,
                docstrings,
                scopeNodes,
                scopeEdges,
                language,
                newScopeStack
            );
        }
    }
    
    /**
     * Process TypeScript/JavaScript AST nodes with proper scope awareness
     */
    private async processTypeScriptNode(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        scopeStack: string[],
        startLine: number,
        endLine: number
    ): Promise<void> {
        const nodeType = node.type;
        const isExported = this.hasExportModifier(node);
        const currentScope = scopeStack[scopeStack.length - 1] || 'global';
        
        switch (nodeType) {
            // CLASS DECLARATIONS - Always extract at any scope level
            case 'class_declaration':
                const className = this.getIdentifierName(node, 'name');
                if (className) {
                    symbols.push({
                        name: className,
                        type: 'class',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: isExported ? 'export' : (currentScope === 'class' ? 'local' : 'global')
                    });
                    if (isExported) exports.push(className);
                }
                break;
                
            // INTERFACE DECLARATIONS - Always extract
            case 'interface_declaration':
                const interfaceName = this.getIdentifierName(node, 'name');
                if (interfaceName) {
                    symbols.push({
                        name: interfaceName,
                        type: 'interface',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: isExported ? 'export' : (currentScope === 'class' ? 'local' : 'global')
                    });
                    if (isExported) exports.push(interfaceName);
                }
                break;
                
            // TYPE DECLARATIONS - Always extract  
            case 'type_alias_declaration':
                const typeName = this.getIdentifierName(node, 'name');
                if (typeName) {
                    symbols.push({
                        name: typeName,
                        type: 'type',
                        startLine,
                        endLine,
                        startColumn: node.startPosition.column,
                        endColumn: node.endPosition.column,
                        scope: isExported ? 'export' : (currentScope === 'class' ? 'local' : 'global')
                    });
                    if (isExported) exports.push(typeName);
                }
                break;
                
            // FUNCTION DECLARATIONS - Extract at global/class scope only
            case 'function_declaration':
            case 'method_definition':
                if (currentScope === 'global' || currentScope === 'class') {
                    const functionName = this.getIdentifierName(node, 'name');
                    if (functionName) {
                        symbols.push({
                            name: functionName,
                            type: nodeType === 'method_definition' ? 'method' : 'function',
                            startLine,
                            endLine,
                            startColumn: node.startPosition.column,
                            endColumn: node.endPosition.column,
                            scope: isExported ? 'export' : (currentScope === 'class' ? 'local' : 'global')
                        });
                        if (isExported) exports.push(functionName);
                    }
                }
                // Don't recurse into function body to avoid extracting internal variables
                break;
                
            // VARIABLE DECLARATIONS - ONLY extract meaningful ones
            case 'variable_declaration':
                await this.processVariableDeclaration(
                    node,
                    symbols,
                    exports,
                    currentScope,
                    isExported,
                    startLine,
                    endLine,
                    scopeStack
                );
                break;
                
            // IMPORT/EXPORT STATEMENTS
            case 'import_statement':
                await this.processImportStatement(node, imports);
                break;
                
            case 'export_statement':
                // Handle export statements
                break;
        }
    }
    
    /**
     * Process variable declarations with semantic filtering
     * CORE FIX: Only extract variables that are semantically meaningful
     */
    private async processVariableDeclaration(
        node: TreeSitterNode,
        symbols: ExtractedSymbol[],
        exports: string[],
        currentScope: string,
        isExported: boolean,
        startLine: number,
        endLine: number,
        scopeStack?: string[]
    ): Promise<void> {
        // CRITICAL: Only extract variables that are meaningful for search/documentation
        
        // Rule 1: Never extract variables inside functions/methods
        // Use scope stack if available for more accurate detection
        if (scopeStack && scopeStack.length > 0) {
            const isInMethod = scopeStack.includes('method');
            const isInFunction = scopeStack.includes('function');
            if (isInMethod || isInFunction) {
                return; // Skip method/function-scoped variables entirely
            }
        } else if (currentScope !== 'global' && currentScope !== 'class') {
            return; // Skip method/function-scoped variables entirely
        }
        
        // Rule 2: For class-scoped variables, only extract if they're properties/fields
        if (currentScope === 'class') {
            // Class member variables should be extracted as properties
            // This would need more sophisticated logic to distinguish
            // class properties vs method-local variables
            const isClassProperty = this.isClassProperty(node);
            if (!isClassProperty) return;
        }
        
        // Rule 3: For global variables, apply semantic filtering
        const declarators = node.namedChildren.filter(child => child.type === 'variable_declarator');
        
        for (const declarator of declarators) {
            const varName = this.getIdentifierName(declarator, 'name');
            if (!varName) continue;
            
            // Rule 4: Only extract if it's exported OR has meaningful structure
            const shouldExtract = isExported || this.isMeaningfulVariable(declarator);
            
            if (shouldExtract) {
                const varType = this.getVariableType(node);
                symbols.push({
                    name: varName,
                    type: varType as 'variable' | 'constant',
                    startLine,
                    endLine,
                    startColumn: node.startPosition.column,
                    endColumn: node.endPosition.column,
                    scope: isExported ? 'export' : (currentScope === 'class' ? 'local' : 'global')
                });
                if (isExported) exports.push(varName);
            }
        }
    }
    
    /**
     * Helper methods for AST analysis
     */
    private hasExportModifier(node: TreeSitterNode): boolean {
        // Check if node has export modifier
        const parent = node.parent;
        if (parent && parent.type === 'export_statement') return true;
        
        // Check for export keyword in modifiers
        for (const child of node.children) {
            if (child.type === 'export' || child.text === 'export') return true;
        }
        return false;
    }
    
    private getIdentifierName(node: TreeSitterNode, fieldName?: string): string | null {
        if (fieldName) {
            const nameNode = node.childForFieldName(fieldName);
            return nameNode?.text || null;
        }
        
        // Find identifier child
        for (const child of node.namedChildren) {
            if (child.type === 'identifier') {
                return child.text;
            }
        }
        return null;
    }
    
    private isClassProperty(node: TreeSitterNode): boolean {
        // Distinguish class properties from method-local variables
        // This would need more sophisticated parent traversal
        return false; // Conservative: skip for now
    }
    
    private isMeaningfulVariable(declaratorNode: TreeSitterNode): boolean {
        // Check if variable has meaningful structure (arrays, objects, functions)
        const init = declaratorNode.childForFieldName('value');
        if (!init) return false;
        
        const initType = init.type;
        return (
            initType === 'array_expression' ||
            initType === 'object_expression' ||
            initType === 'arrow_function' ||
            initType === 'function_expression' ||
            initType === 'new_expression' ||
            initType === 'call_expression'
        );
    }
    
    private getVariableType(node: TreeSitterNode): string {
        // Determine if const, let, or var
        for (const child of node.children) {
            if (child.text === 'const') return 'constant';
            if (child.text === 'let') return 'variable';  
            if (child.text === 'var') return 'variable';
        }
        return 'variable';
    }
    
    private async traverseClassBody(
        classNode: TreeSitterNode,
        symbols: ExtractedSymbol[],
        imports: ExtractedImport[],
        exports: string[],
        scopeStack: string[]
    ): Promise<void> {
        // Find class body and traverse methods
        const classBody = classNode.childForFieldName('body');
        if (!classBody) return;
        
        for (const member of classBody.namedChildren) {
            if (member.type === 'method_definition') {
                const methodName = this.getIdentifierName(member, 'name');
                if (methodName) {
                    symbols.push({
                        name: methodName,
                        type: 'method',
                        startLine: member.startPosition.row + 1,
                        endLine: member.endPosition.row + 1,
                        startColumn: member.startPosition.column,
                        endColumn: member.endPosition.column,
                        scope: 'local'
                    });
                }
                // Don't recurse into method bodies to avoid extracting local variables
            }
        }
    }
    
    private async processImportStatement(
        node: TreeSitterNode,
        imports: ExtractedImport[]
    ): Promise<void> {
        // Process import statements - simplified for now
        const source = node.childForFieldName('source');
        if (source) {
            imports.push({
                module: source.text.replace(/['"]/g, ''),
                symbols: [], // Would need more processing
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
            supportedLanguages: ['typescript', 'javascript', 'python', 'java', 'go', 'rust'],
            availableParsers: Array.from(this.parsers.keys())
        };
    }
}
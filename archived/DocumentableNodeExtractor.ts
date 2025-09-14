/**
 * DocumentableNodeExtractor - Extracts complete logical code units
 * 
 * Inspired by Cody's documentableNodes approach but using regex-based parsing
 * for languages where Tree-sitter isn't available. Focuses on extracting
 * complete functions, classes, and interfaces with proper boundaries.
 */

import { Logger } from '../../utils/Logger.js';

export interface DocumentableNode {
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'method' | 'variable';
    startLine: number;
    endLine: number;
    content: string;
    scope: 'local' | 'export' | 'global';
    precedingComment?: string;
    imports: string[];
    language: string;
}

export interface ChunkExtractionResult {
    nodes: DocumentableNode[];
    imports: string[];
    errors: string[];
}

export class DocumentableNodeExtractor {
    private logger: Logger;

    constructor() {
        this.logger = new Logger('DOCUMENTABLE-EXTRACTOR', 'info');
    }

    /**
     * Extract complete logical code units from file content
     * Following Cody's approach of preserving complete boundaries
     */
    extractNodes(
        content: string,
        filePath: string,
        language: string
    ): ChunkExtractionResult {
        const lines = content.split('\n');
        const nodes: DocumentableNode[] = [];
        const fileImports: string[] = [];
        const errors: string[] = [];

        try {
            // Extract file-level imports first
            const extractedImports = this.extractFileImports(lines, language);
            fileImports.push(...extractedImports);

            // Extract documentable nodes based on language
            switch (language) {
                case 'typescript':
                case 'javascript':
                    this.extractJavaScriptNodes(lines, nodes, fileImports, language);
                    break;
                case 'python':
                    this.extractPythonNodes(lines, nodes, fileImports, language);
                    break;
                case 'php':
                    this.extractPHPNodes(lines, nodes, fileImports, language);
                    break;
                default:
                    this.logger.warn(`Language ${language} not fully supported, using basic extraction`);
                    this.extractBasicNodes(lines, nodes, fileImports, language);
            }

            this.logger.debug(`Extracted ${nodes.length} documentable nodes from ${filePath}`);
        } catch (error) {
            const errorMsg = `Failed to extract nodes from ${filePath}: ${error}`;
            this.logger.error(errorMsg);
            errors.push(errorMsg);
        }

        return { nodes, imports: fileImports, errors };
    }

    /**
     * Extract JavaScript/TypeScript documentable nodes with complete boundaries
     * Follows Cody's documentableNodes pattern but using regex
     */
    private extractJavaScriptNodes(
        lines: string[],
        nodes: DocumentableNode[],
        fileImports: string[],
        language: string
    ): void {
        let i = 0;
        
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // Skip empty lines and single-line comments
            if (!line || line.startsWith('//')) {
                i++;
                continue;
            }

            // Function declarations
            const functionMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
            if (functionMatch) {
                const node = this.extractCompleteFunction(lines, i, functionMatch[1], 'function', language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine; // Skip to end of this node
                    continue;
                }
            }

            // Class declarations
            const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
            if (classMatch) {
                const node = this.extractCompleteClass(lines, i, classMatch[1], language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            // Interface declarations
            const interfaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/);
            if (interfaceMatch) {
                const node = this.extractCompleteInterface(lines, i, interfaceMatch[1], language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            // Type declarations
            const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
            if (typeMatch) {
                const node = this.extractCompleteType(lines, i, typeMatch[1], language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            i++;
        }
    }

    /**
     * Extract complete function with proper boundaries
     * Includes preceding comments and complete body
     */
    private extractCompleteFunction(
        lines: string[],
        startIndex: number,
        name: string,
        type: 'function' | 'method',
        language: string
    ): DocumentableNode | null {
        // Find preceding comments
        const commentStart = this.findPrecedingComments(lines, startIndex);
        
        // Find function end by matching braces
        const functionEnd = this.findBlockEnd(lines, startIndex);
        if (functionEnd === -1) {
            return null; // Incomplete function
        }

        // Extract complete content including comments
        const contentLines = lines.slice(commentStart, functionEnd + 1);
        const content = contentLines.join('\n');
        
        // Get preceding comment if exists
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        const isExport = lines[startIndex].includes('export');

        return {
            name,
            type,
            startLine: commentStart + 1, // 1-indexed
            endLine: functionEnd + 1,
            content,
            scope: isExport ? 'export' : 'local',
            precedingComment,
            imports: [], // Will be set by caller
            language
        };
    }

    /**
     * Extract complete class with all methods
     */
    private extractCompleteClass(
        lines: string[],
        startIndex: number,
        name: string,
        language: string
    ): DocumentableNode | null {
        const commentStart = this.findPrecedingComments(lines, startIndex);
        const classEnd = this.findBlockEnd(lines, startIndex);
        
        if (classEnd === -1) return null;

        const contentLines = lines.slice(commentStart, classEnd + 1);
        const content = contentLines.join('\n');
        
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        const isExport = lines[startIndex].includes('export');

        return {
            name,
            type: 'class',
            startLine: commentStart + 1,
            endLine: classEnd + 1,
            content,
            scope: isExport ? 'export' : 'local',
            precedingComment,
            imports: [],
            language
        };
    }

    /**
     * Extract complete interface declaration
     */
    private extractCompleteInterface(
        lines: string[],
        startIndex: number,
        name: string,
        language: string
    ): DocumentableNode | null {
        const commentStart = this.findPrecedingComments(lines, startIndex);
        const interfaceEnd = this.findBlockEnd(lines, startIndex);
        
        if (interfaceEnd === -1) return null;

        const contentLines = lines.slice(commentStart, interfaceEnd + 1);
        const content = contentLines.join('\n');
        
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        const isExport = lines[startIndex].includes('export');

        return {
            name,
            type: 'interface',
            startLine: commentStart + 1,
            endLine: interfaceEnd + 1,
            content,
            scope: isExport ? 'export' : 'local',
            precedingComment,
            imports: [],
            language
        };
    }

    /**
     * Extract complete type declaration
     */
    private extractCompleteType(
        lines: string[],
        startIndex: number,
        name: string,
        language: string
    ): DocumentableNode | null {
        const commentStart = this.findPrecedingComments(lines, startIndex);
        
        // For type aliases, find the end of the type definition
        let endIndex = startIndex;
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        
        // Simple type definition - single line or multi-line object type
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            
            for (let j = 0; j < line.length; j++) {
                const char = line[j];
                
                if (inString) {
                    if (char === stringChar && line[j-1] !== '\\') {
                        inString = false;
                    }
                    continue;
                }
                
                if (char === '"' || char === "'" || char === '`') {
                    inString = true;
                    stringChar = char;
                    continue;
                }
                
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }
            
            endIndex = i;
            
            // If no braces or braces are balanced and line ends with semicolon
            if (braceCount === 0 && (line.trim().endsWith(';') || line.trim().endsWith('}') || !line.includes('{'))) {
                break;
            }
        }

        const contentLines = lines.slice(commentStart, endIndex + 1);
        const content = contentLines.join('\n');
        
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        const isExport = lines[startIndex].includes('export');

        return {
            name,
            type: 'type',
            startLine: commentStart + 1,
            endLine: endIndex + 1,
            content,
            scope: isExport ? 'export' : 'local',
            precedingComment,
            imports: [],
            language
        };
    }

    /**
     * Extract Python documentable nodes
     */
    private extractPythonNodes(
        lines: string[],
        nodes: DocumentableNode[],
        fileImports: string[],
        language: string
    ): void {
        let i = 0;
        
        while (i < lines.length) {
            const line = lines[i].trim();
            
            if (!line || line.startsWith('#')) {
                i++;
                continue;
            }

            // Function definitions
            const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
            if (funcMatch) {
                const node = this.extractPythonFunction(lines, i, funcMatch[1], fileImports, language);
                if (node) {
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            // Class definitions
            const classMatch = line.match(/^class\s+(\w+)\s*(?:\([^)]*\))?:/);
            if (classMatch) {
                const node = this.extractPythonClass(lines, i, classMatch[1], fileImports, language);
                if (node) {
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            i++;
        }
    }

    /**
     * Extract Python function with proper indentation handling
     */
    private extractPythonFunction(
        lines: string[],
        startIndex: number,
        name: string,
        imports: string[],
        language: string
    ): DocumentableNode | null {
        const commentStart = this.findPrecedingComments(lines, startIndex);
        const functionEnd = this.findPythonBlockEnd(lines, startIndex);
        
        if (functionEnd === -1) return null;

        const contentLines = lines.slice(commentStart, functionEnd + 1);
        const content = contentLines.join('\n');
        
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        return {
            name,
            type: 'function',
            startLine: commentStart + 1,
            endLine: functionEnd + 1,
            content,
            scope: name.startsWith('_') ? 'local' : 'global',
            precedingComment,
            imports,
            language
        };
    }

    /**
     * Extract Python class
     */
    private extractPythonClass(
        lines: string[],
        startIndex: number,
        name: string,
        imports: string[],
        language: string
    ): DocumentableNode | null {
        const commentStart = this.findPrecedingComments(lines, startIndex);
        const classEnd = this.findPythonBlockEnd(lines, startIndex);
        
        if (classEnd === -1) return null;

        const contentLines = lines.slice(commentStart, classEnd + 1);
        const content = contentLines.join('\n');
        
        const precedingComment = commentStart < startIndex ? 
            lines.slice(commentStart, startIndex).join('\n').trim() : undefined;

        return {
            name,
            type: 'class',
            startLine: commentStart + 1,
            endLine: classEnd + 1,
            content,
            scope: name.startsWith('_') ? 'local' : 'global',
            precedingComment,
            imports,
            language
        };
    }

    /**
     * Find Python block end using indentation
     */
    private findPythonBlockEnd(lines: string[], startIndex: number): number {
        const baseLine = lines[startIndex];
        const baseIndentation = baseLine.length - baseLine.trimStart().length;
        
        for (let i = startIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            
            // Skip empty lines and comments
            if (!line.trim() || line.trim().startsWith('#')) {
                continue;
            }
            
            const currentIndentation = line.length - line.trimStart().length;
            
            // If we find a line at the same or less indentation, the block has ended
            if (currentIndentation <= baseIndentation) {
                return i - 1;
            }
        }
        
        // If we reach the end of the file, that's the end of the block
        return lines.length - 1;
    }

    /**
     * Extract PHP documentable nodes with complete boundaries
     */
    private extractPHPNodes(
        lines: string[],
        nodes: DocumentableNode[],
        fileImports: string[],
        language: string
    ): void {
        let i = 0;
        
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // Skip empty lines and comments
            if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*')) {
                i++;
                continue;
            }

            // Class declarations
            const classMatch = line.match(/^(?:abstract\s+|final\s+)?class\s+(\w+)/);
            if (classMatch) {
                const node = this.extractCompleteClass(lines, i, classMatch[1], language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            // Function declarations
            const functionMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*\(/);
            if (functionMatch) {
                const node = this.extractCompleteFunction(lines, i, functionMatch[1], 'function', language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }
            
            // Interface declarations
            const interfaceMatch = line.match(/^interface\s+(\w+)/);
            if (interfaceMatch) {
                const node = this.extractCompleteInterface(lines, i, interfaceMatch[1], language);
                if (node) {
                    node.imports = fileImports;
                    nodes.push(node);
                    i = node.endLine;
                    continue;
                }
            }

            i++;
        }
    }

    /**
     * Find the end of a block structure (for JavaScript/TypeScript/PHP)
     * Matches opening and closing braces
     */
    private findBlockEnd(lines: string[], startIndex: number): number {
        let braceCount = 0;
        let foundOpenBrace = false;
        
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            
            for (const char of line) {
                if (char === '{') {
                    braceCount++;
                    foundOpenBrace = true;
                } else if (char === '}') {
                    braceCount--;
                    
                    if (foundOpenBrace && braceCount === 0) {
                        return i; // Found the matching closing brace
                    }
                }
            }
        }
        
        return -1; // No matching closing brace found
    }

    /**
     * Find preceding comments (JSDoc, block comments, etc.)
     * Similar to Cody's approach of including context
     */
    private findPrecedingComments(lines: string[], startIndex: number): number {
        let commentStart = startIndex;
        
        for (let i = startIndex - 1; i >= 0; i--) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (line === '') {
                continue;
            }
            
            // Check for various comment patterns
            if (line.startsWith('//') ||           // Single line comments
                line.startsWith('/*') ||           // Block comment start
                line.includes('*/') ||             // Block comment end
                line.startsWith('*') ||            // JSDoc continuation
                line.startsWith('#') ||            // Python comments
                line.startsWith('"""') ||          // Python docstrings
                line.startsWith("'''")) {          // Python docstrings
                commentStart = i;
                continue;
            }
            
            // Stop at non-comment content
            break;
        }
        
        return commentStart;
    }

    /**
     * Extract file-level imports
     */
    private extractFileImports(lines: string[], language: string): string[] {
        const imports: string[] = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            switch (language) {
                case 'typescript':
                case 'javascript':
                    // ES6 imports
                    const esImportMatch = trimmed.match(/^import.*from\s+['"]([^'"]+)['"]/);
                    if (esImportMatch) {
                        imports.push(esImportMatch[1]);
                    }
                    
                    // CommonJS requires
                    const requireMatch = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
                    if (requireMatch) {
                        imports.push(requireMatch[1]);
                    }
                    break;
                    
                case 'python':
                    // from ... import ...
                    const fromImportMatch = trimmed.match(/^from\s+([^\s]+)\s+import/);
                    if (fromImportMatch) {
                        imports.push(fromImportMatch[1]);
                    }
                    
                    // import ...
                    const importMatch = trimmed.match(/^import\s+([^\s]+)/);
                    if (importMatch) {
                        imports.push(importMatch[1]);
                    }
                    break;
                    
                case 'php':
                    // require/include statements
                    const phpRequireMatch = trimmed.match(/^(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]\s*\)?/);
                    if (phpRequireMatch) {
                        imports.push(phpRequireMatch[1]);
                    }
                    
                    // use statements
                    const phpUseMatch = trimmed.match(/^use\s+([^;]+);/);
                    if (phpUseMatch) {
                        imports.push(phpUseMatch[1].trim());
                    }
                    break;
            }
        }
        
        return imports;
    }

    /**
     * Fallback extraction for unsupported languages
     */
    private extractBasicNodes(
        lines: string[],
        nodes: DocumentableNode[],
        fileImports: string[],
        language: string
    ): void {
        // Basic extraction - just look for function-like patterns
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Very basic function detection
            const funcMatch = line.match(/^\s*(?:function|def|fn)\s+(\w+)/);
            if (funcMatch) {
                nodes.push({
                    name: funcMatch[1],
                    type: 'function',
                    startLine: i + 1,
                    endLine: i + 1, // Single line fallback
                    content: line,
                    scope: 'local',
                    imports: fileImports,
                    language
                });
            }
        }
    }
}
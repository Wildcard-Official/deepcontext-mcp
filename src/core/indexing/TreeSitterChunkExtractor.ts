/**
 * TreeSitterChunkExtractor - AST-Based Semantic Chunking
 * 
 * Creates meaningful code chunks based on AST structure rather than individual symbols.
 * Inspired by research from:
 * - the-dream-machine/ebdde5abc0e7432d66ca16bc48c8108d
 * - CintraAI/code-chunker 
 * - yilinjz/astchunk
 * 
 * Key Principle: Extract complete semantic units (full classes, functions, interfaces)
 * not individual symbol metadata.
 */

import { Logger } from '../../utils/Logger.js';
import * as crypto from 'crypto';

// Import Tree-sitter modules
let Parser: any;
let TypeScriptLanguage: any;
let JavaScriptLanguage: any;

// Lazy load Tree-sitter modules
async function loadTreeSitter() {
    if (!Parser) {
        Parser = (await import('tree-sitter')).default;
        const tsModule = await import('tree-sitter-typescript');
        const jsModule = await import('tree-sitter-javascript');
        
        TypeScriptLanguage = tsModule.default.typescript;
        JavaScriptLanguage = jsModule.default;
    }
}

interface TreeSitterNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TreeSitterNode[];
    namedChildren: TreeSitterNode[];
    startIndex: number;
    endIndex: number;
    parent?: TreeSitterNode;
}

export interface SemanticChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    chunkType: 'class' | 'function' | 'interface' | 'type' | 'module' | 'mixed';
    symbols: Array<{
        name: string;
        type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant';
        line: number;
        scope?: string;
    }>;
    imports: Array<{
        module: string;
        symbols: string[];
        line: number;
    }>;
    size: number; // character count
    complexity: 'low' | 'medium' | 'high'; // based on nested structures
}

export interface ChunkExtractionResult {
    chunks: SemanticChunk[];
    parseErrors: string[];
    metadata: {
        totalNodes: number;
        totalChunks: number;
        averageChunkSize: number;
        processingTime: number;
    };
}

export class TreeSitterChunkExtractor {
    private parsers = new Map<string, any>();
    private initialized = false;
    private logger: Logger;
    
    // Chunking parameters (based on research)
    private readonly MAX_CHUNK_SIZE = 2000; // characters, similar to astchunk
    private readonly MIN_CHUNK_SIZE = 100;  // avoid tiny fragments
    private readonly PREFERRED_CHUNK_SIZE = 1000; // sweet spot for search

    constructor() {
        this.logger = new Logger('TREESITTER-CHUNKER', 'info');
    }

    /**
     * Generate a short, unique ID that fits within Turbopuffer's 64-byte limit
     */
    private generateShortId(filePath: string, suffix: string): string {
        // Extract just the filename from the path
        const fileName = filePath.split('/').pop() || filePath;
        const baseName = fileName.split('.')[0]; // Remove extensions
        
        // Create a short hash from the full path for uniqueness
        const pathHash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 8);
        
        // Combine into a short ID: basename_hash_suffix
        const shortId = `${baseName}_${pathHash}_${suffix}`;
        
        // Ensure it's under 64 bytes
        return shortId.length > 60 ? shortId.substring(0, 60) : shortId;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            await loadTreeSitter();
            
            // Initialize parsers
            const tsParser = new Parser();
            tsParser.setLanguage(TypeScriptLanguage);
            this.parsers.set('typescript', tsParser);
            
            const jsParser = new Parser();
            jsParser.setLanguage(JavaScriptLanguage);
            this.parsers.set('javascript', jsParser);
            
            this.initialized = true;
            this.logger.info('✅ Tree-sitter chunker initialized successfully');
            
        } catch (error) {
            this.logger.error(`❌ Tree-sitter chunker initialization failed: ${error}`);
            throw error;
        }
    }

    /**
     * Extract semantic chunks from source code using AST structure
     */
    async extractSemanticChunks(
        content: string,
        language: string,
        filePath: string,
        relativePath: string = filePath
    ): Promise<ChunkExtractionResult> {
        const startTime = Date.now();
        await this.initialize();

        if (!this.parsers.has(language)) {
            throw new Error(`Unsupported language: ${language}`);
        }

        const parser = this.parsers.get(language)!;
        const chunks: SemanticChunk[] = [];
        const parseErrors: string[] = [];

        try {
            // Check for Tree-sitter's 32KB limit
            const TREESITTER_LIMIT = 32768; // 2^15 bytes
            
            if (content.length > TREESITTER_LIMIT) {
                this.logger.warn(`File ${filePath} (${content.length} chars) exceeds Tree-sitter limit, using smart pre-chunking`);
                return this.handleLargeFile(content, filePath, relativePath, language, parser);
            }

            // Parse the entire file to get AST
            const tree = parser.parse(content);
            const rootNode = tree.rootNode;

            // Find semantic units in the AST
            const semanticUnits = this.findSemanticUnits(rootNode, content);
            
            // Convert semantic units to chunks
            for (const unit of semanticUnits) {
                const chunk = await this.createChunkFromUnit(
                    unit,
                    content,
                    filePath,
                    relativePath,
                    language
                );
                
                if (chunk) {
                    chunks.push(chunk);
                }
            }

            // Handle any remaining content that wasn't captured in semantic units
            const uncapturedChunks = this.handleUncapturedContent(
                content,
                chunks,
                filePath,
                relativePath,
                language
            );
            
            chunks.push(...uncapturedChunks);

            const processingTime = Date.now() - startTime;
            const totalNodes = this.countNodes(rootNode);
            const averageChunkSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0) / chunks.length || 0;

            this.logger.info(`Created ${chunks.length} semantic chunks from ${filePath}`);

            return {
                chunks,
                parseErrors,
                metadata: {
                    totalNodes,
                    totalChunks: chunks.length,
                    averageChunkSize,
                    processingTime
                }
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Chunking failed for ${filePath}: ${errorMessage}`);
            parseErrors.push(`AST parsing failed: ${errorMessage}`);
            
            // Fallback to simple chunking
            return this.fallbackToSimpleChunking(content, filePath, relativePath, language);
        }
    }

    /**
     * Find semantic units in the AST (complete classes, functions, interfaces, etc.)
     */
    private findSemanticUnits(rootNode: TreeSitterNode, sourceCode: string): SemanticUnit[] {
        const units: SemanticUnit[] = [];

        // Define what constitutes a semantic unit based on AST node types
        const semanticNodeTypes = new Set([
            'class_declaration',
            'interface_declaration', 
            'type_alias_declaration',
            'function_declaration',
            'method_definition',
            'arrow_function',
            'export_statement',
            'namespace_declaration',
            'enum_declaration'
        ]);

        // Traverse AST to find semantic units
        this.traverseForSemanticUnits(rootNode, units, semanticNodeTypes, sourceCode);

        // Sort units by position
        units.sort((a, b) => a.startIndex - b.startIndex);

        // Merge small adjacent units and handle overlaps
        return this.optimizeSemanticUnits(units, sourceCode);
    }

    private traverseForSemanticUnits(
        node: TreeSitterNode,
        units: SemanticUnit[],
        semanticTypes: Set<string>,
        sourceCode: string
    ): void {
        // Check if this node represents a semantic unit
        if (semanticTypes.has(node.type)) {
            const unitText = sourceCode.slice(node.startIndex, node.endIndex);
            
            // Only include units that meet size criteria
            if (unitText.length >= this.MIN_CHUNK_SIZE && unitText.length <= this.MAX_CHUNK_SIZE) {
                units.push({
                    type: this.mapNodeTypeToChunkType(node.type),
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    startLine: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    node: node,
                    content: unitText
                });
                
                // For classes and namespaces, don't traverse children (we want the complete unit)
                if (['class_declaration', 'namespace_declaration'].includes(node.type)) {
                    return;
                }
            }
        }

        // Continue traversal for child nodes
        for (const child of node.namedChildren) {
            this.traverseForSemanticUnits(child, units, semanticTypes, sourceCode);
        }
    }

    private optimizeSemanticUnits(units: SemanticUnit[], sourceCode: string): SemanticUnit[] {
        const optimized: SemanticUnit[] = [];
        let currentUnit: SemanticUnit | null = null;

        for (const unit of units) {
            if (!currentUnit) {
                currentUnit = unit;
                continue;
            }

            const gap = unit.startIndex - currentUnit.endIndex;
            const combinedSize = (unit.endIndex - currentUnit.startIndex);

            // Merge if gap is small and combined size is reasonable
            if (gap < 100 && combinedSize <= this.MAX_CHUNK_SIZE) {
                // Merge units
                currentUnit = {
                    type: 'mixed',
                    startIndex: currentUnit.startIndex,
                    endIndex: unit.endIndex,
                    startLine: currentUnit.startLine,
                    endLine: unit.endLine,
                    node: currentUnit.node, // Keep first node as reference
                    content: sourceCode.slice(currentUnit.startIndex, unit.endIndex)
                };
            } else {
                // Add current unit and start new one
                optimized.push(currentUnit);
                currentUnit = unit;
            }
        }

        if (currentUnit) {
            optimized.push(currentUnit);
        }

        return optimized;
    }

    private async createChunkFromUnit(
        unit: SemanticUnit,
        sourceCode: string,
        filePath: string,
        relativePath: string,
        language: string
    ): Promise<SemanticChunk> {
        // Extract symbols from this unit
        const symbols = this.extractSymbolsFromUnit(unit);
        
        // Extract imports (look at the beginning of the file)
        const imports = this.extractImportsFromUnit(unit);
        
        // Generate unique chunk ID (short format for Turbopuffer)
        const chunkId = this.generateShortId(filePath, `${unit.startLine}-${unit.endLine}`);

        return {
            id: chunkId,
            content: unit.content,
            filePath,
            relativePath,
            startLine: unit.startLine,
            endLine: unit.endLine,
            language,
            chunkType: unit.type,
            symbols,
            imports,
            size: unit.content.length,
            complexity: this.calculateComplexity(unit.content)
        };
    }

    private extractSymbolsFromUnit(unit: SemanticUnit): SemanticChunk['symbols'] {
        const symbols: SemanticChunk['symbols'] = [];
        
        // Extract symbols from the AST node AND its children
        this.traverseNodeForSymbols(unit.node, symbols);
        
        // If no symbols found from main node, try to extract from content
        if (symbols.length === 0 && unit.node) {
            this.extractSymbolsFromContent(unit.content, unit.type, symbols, unit.startLine);
        }
        
        return symbols;
    }

    private extractSymbolsFromContent(
        content: string,
        chunkType: SemanticChunk['chunkType'],
        symbols: SemanticChunk['symbols'],
        startLine: number
    ): void {
        // Fallback: extract symbols using regex patterns when AST traversal fails
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
            const lineNumber = startLine + index;
            const trimmedLine = line.trim();
            
            // Extract class declarations
            const classMatch = trimmedLine.match(/^(?:export\s+)?class\s+(\w+)/);
            if (classMatch) {
                symbols.push({
                    name: classMatch[1],
                    type: 'class',
                    line: lineNumber
                });
            }
            
            // Extract interface declarations
            const interfaceMatch = trimmedLine.match(/^(?:export\s+)?interface\s+(\w+)/);
            if (interfaceMatch) {
                symbols.push({
                    name: interfaceMatch[1],
                    type: 'interface',
                    line: lineNumber
                });
            }
            
            // Extract function declarations
            const functionMatch = trimmedLine.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            if (functionMatch) {
                symbols.push({
                    name: functionMatch[1],
                    type: 'function',
                    line: lineNumber
                });
            }
            
            // Extract method definitions
            const methodMatch = trimmedLine.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{\{]/);
            if (methodMatch && !trimmedLine.includes('if') && !trimmedLine.includes('for') && !trimmedLine.includes('while')) {
                symbols.push({
                    name: methodMatch[1],
                    type: 'function',
                    line: lineNumber
                });
            }
            
            // Extract type aliases
            const typeMatch = trimmedLine.match(/^(?:export\s+)?type\s+(\w+)/);
            if (typeMatch) {
                symbols.push({
                    name: typeMatch[1],
                    type: 'type',
                    line: lineNumber
                });
            }
            
            // Extract const declarations
            const constMatch = trimmedLine.match(/^(?:export\s+)?const\s+(\w+)/);
            if (constMatch) {
                symbols.push({
                    name: constMatch[1],
                    type: 'constant',
                    line: lineNumber
                });
            }
        });
    }

    private traverseNodeForSymbols(node: TreeSitterNode, symbols: SemanticChunk['symbols']): void {
        // Extract symbol based on node type
        switch (node.type) {
            case 'class_declaration':
            case 'interface_declaration':
            case 'type_alias_declaration':
            case 'function_declaration':
                const name = this.getNodeName(node);
                if (name) {
                    symbols.push({
                        name,
                        type: this.mapNodeTypeToSymbolType(node.type),
                        line: node.startPosition.row + 1
                    });
                }
                break;
        }

        // Traverse children for nested symbols
        for (const child of node.namedChildren) {
            this.traverseNodeForSymbols(child, symbols);
        }
    }

    private extractImportsFromUnit(unit: SemanticUnit): SemanticChunk['imports'] {
        // For now, return empty - imports are typically at file level
        return [];
    }

    private calculateComplexity(content: string): 'low' | 'medium' | 'high' {
        const lines = content.split('\n').length;
        const nestingLevel = (content.match(/{/g) || []).length;
        
        if (lines < 20 && nestingLevel < 3) return 'low';
        if (lines < 100 && nestingLevel < 10) return 'medium';
        return 'high';
    }

    private mapNodeTypeToChunkType(nodeType: string): SemanticChunk['chunkType'] {
        switch (nodeType) {
            case 'class_declaration': return 'class';
            case 'interface_declaration': return 'interface';
            case 'type_alias_declaration': return 'type';
            case 'function_declaration':
            case 'method_definition':
            case 'arrow_function': return 'function';
            case 'namespace_declaration': return 'module';
            default: return 'mixed';
        }
    }

    private mapNodeTypeToSymbolType(nodeType: string): SemanticChunk['symbols'][0]['type'] {
        switch (nodeType) {
            case 'class_declaration': return 'class';
            case 'interface_declaration': return 'interface';
            case 'type_alias_declaration': return 'type';
            case 'function_declaration': return 'function';
            default: return 'variable';
        }
    }

    private getNodeName(node: TreeSitterNode): string | null {
        // Try to find identifier child node
        for (const child of node.namedChildren) {
            if (child.type === 'identifier') {
                return child.text;
            }
        }
        return null;
    }

    private countNodes(node: TreeSitterNode): number {
        let count = 1;
        for (const child of node.children) {
            count += this.countNodes(child);
        }
        return count;
    }

    private handleUncapturedContent(
        content: string,
        existingChunks: SemanticChunk[],
        filePath: string,
        relativePath: string,
        language: string
    ): SemanticChunk[] {
        // For now, don't create additional chunks for uncaptured content
        // This could be enhanced to handle module-level code, comments, etc.
        return [];
    }

    private async handleLargeFile(
        content: string,
        filePath: string,
        relativePath: string,
        language: string,
        parser: any
    ): Promise<ChunkExtractionResult> {
        // Smart pre-chunking for large files
        // Split file into smaller sections that Tree-sitter can handle
        const lines = content.split('\n');
        const LINES_PER_SECTION = 1000; // Aim for ~30KB sections
        const allChunks: SemanticChunk[] = [];
        const allErrors: string[] = [];
        
        for (let i = 0; i < lines.length; i += LINES_PER_SECTION) {
            const sectionLines = lines.slice(i, i + LINES_PER_SECTION);
            const sectionContent = sectionLines.join('\n');
            
            if (sectionContent.length < 32768) {
                try {
                    const sectionResult = await this.extractSemanticChunks(
                        sectionContent,
                        language,
                        `${filePath}:section${i}`,
                        `${relativePath}:section${i}`
                    );
                    
                    // Adjust line numbers for the chunks
                    sectionResult.chunks.forEach(chunk => {
                        chunk.startLine += i;
                        chunk.endLine += i;
                        chunk.id = this.generateShortId(filePath, `${chunk.startLine}-${chunk.endLine}`);
                        chunk.filePath = filePath;
                        chunk.relativePath = relativePath;
                        
                        // Adjust symbol line numbers
                        chunk.symbols.forEach(symbol => {
                            symbol.line += i;
                        });
                    });
                    
                    allChunks.push(...sectionResult.chunks);
                    allErrors.push(...sectionResult.parseErrors);
                    
                } catch (error) {
                    this.logger.warn(`Section ${i} parsing failed: ${error}`);
                    allErrors.push(`Section ${i}: ${error}`);
                    
                    // Fallback to simple chunking for this section
                    const fallbackChunk = this.createFallbackChunkFromSection(
                        sectionContent, filePath, relativePath, language, i
                    );
                    allChunks.push(fallbackChunk);
                }
            } else {
                // Section still too large, create fallback chunk
                const fallbackChunk = this.createFallbackChunkFromSection(
                    sectionContent, filePath, relativePath, language, i
                );
                allChunks.push(fallbackChunk);
            }
        }
        
        const avgChunkSize = allChunks.reduce((sum, chunk) => sum + chunk.size, 0) / allChunks.length || 0;
        
        return {
            chunks: allChunks,
            parseErrors: allErrors,
            metadata: {
                totalNodes: 0, // Can't calculate for large files
                totalChunks: allChunks.length,
                averageChunkSize: avgChunkSize,
                processingTime: 0
            }
        };
    }

    private createFallbackChunkFromSection(
        content: string,
        filePath: string,
        relativePath: string,
        language: string,
        startLineOffset: number
    ): SemanticChunk {
        const lines = content.split('\n');
        const symbols: SemanticChunk['symbols'] = [];
        
        // Extract symbols using regex as fallback
        this.extractSymbolsFromContent(content, 'mixed', symbols, startLineOffset + 1);
        
        return {
            id: this.generateShortId(filePath, `fallback_${startLineOffset}`),
            content,
            filePath,
            relativePath,
            startLine: startLineOffset + 1,
            endLine: startLineOffset + lines.length,
            language,
            chunkType: 'mixed',
            symbols,
            imports: [],
            size: content.length,
            complexity: this.calculateComplexity(content)
        };
    }

    private fallbackToSimpleChunking(
        content: string,
        filePath: string,
        relativePath: string,
        language: string
    ): ChunkExtractionResult {
        this.logger.warn(`Falling back to simple chunking for ${filePath}`);
        
        // Simple line-based chunking as fallback
        const lines = content.split('\n');
        const chunks: SemanticChunk[] = [];
        const chunkSize = 50; // lines per chunk
        
        for (let i = 0; i < lines.length; i += chunkSize) {
            const chunkLines = lines.slice(i, i + chunkSize);
            const chunkContent = chunkLines.join('\n');
            const symbols: SemanticChunk['symbols'] = [];
            
            // Extract symbols from this chunk
            this.extractSymbolsFromContent(chunkContent, 'mixed', symbols, i + 1);
            
            chunks.push({
                id: this.generateShortId(filePath, `fb_${i}`),
                content: chunkContent,
                filePath,
                relativePath,
                startLine: i + 1,
                endLine: i + chunkLines.length,
                language,
                chunkType: 'mixed',
                symbols,
                imports: [],
                size: chunkContent.length,
                complexity: 'low'
            });
        }

        return {
            chunks,
            parseErrors: ['Fallback chunking used'],
            metadata: {
                totalNodes: 0,
                totalChunks: chunks.length,
                averageChunkSize: chunks.reduce((sum, chunk) => sum + chunk.size, 0) / chunks.length || 0,
                processingTime: 0
            }
        };
    }
}

// Helper interface for internal use
interface SemanticUnit {
    type: SemanticChunk['chunkType'];
    startIndex: number;
    endIndex: number;
    startLine: number;
    endLine: number;
    node: TreeSitterNode;
    content: string;
}
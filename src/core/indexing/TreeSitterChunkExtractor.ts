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
            // TreeSitter's actual limit based on testing
            const TREESITTER_LIMIT = 32768; // 32KB - TreeSitter's proven reliable limit
            
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
        this.logger.info(`Using intelligent TreeSitter range-based parsing for large file: ${filePath}`);

        // Use intelligent range-based TreeSitter parsing instead of crude fallback
        return await this.intelligentRangeBasedParsing(
            content, filePath, relativePath, language, parser
        );
    }

    /**
     * Intelligent Range-Based TreeSitter Parsing
     * Splits large files into semantic ranges and parses each with TreeSitter
     */
    private async intelligentRangeBasedParsing(
        content: string,
        filePath: string,
        relativePath: string,
        language: string,
        parser: any
    ): Promise<ChunkExtractionResult> {
        const startTime = Date.now();
        const WINDOW_SIZE = 30000; // 30KB windows (safe under 32KB limit)
        const OVERLAP_SIZE = 2000;  // 2KB overlap for context preservation

        // Step 1: Find semantic boundaries (class/function/interface starts)
        const semanticBoundaries = this.findSemanticBoundaries(content);

        // Step 2: Create overlapping windows that respect semantic boundaries
        const windows = this.createIntelligentWindows(
            content, semanticBoundaries, WINDOW_SIZE, OVERLAP_SIZE
        );

        this.logger.info(`Created ${windows.length} intelligent windows for TreeSitter parsing`);

        const allChunks: SemanticChunk[] = [];
        const allErrors: string[] = [];
        let totalNodes = 0;

        // Step 3: Parse each window with TreeSitter
        for (let i = 0; i < windows.length; i++) {
            const window = windows[i];

            try {
                this.logger.debug(`Parsing window ${i + 1}/${windows.length} (${window.content.length} chars)`);

                const tree = parser.parse(window.content);
                const rootNode = tree.rootNode;

                if (rootNode.hasError) {
                    allErrors.push(`Window ${i} has parse errors`);
                }

                // Create comprehensive chunks from this window to ensure full content coverage
                const windowChunks = await this.createComprehensiveWindowChunks(
                    rootNode,
                    window.content,
                    filePath,
                    relativePath,
                    language,
                    i
                );
                totalNodes += this.countNodes(rootNode);

                // Adjust line numbers to file coordinates and add to collection
                for (const chunk of windowChunks) {
                    chunk.startLine += window.startLine;
                    chunk.endLine += window.startLine;
                    chunk.id = this.generateShortId(filePath, `w${i}_${chunk.startLine}-${chunk.endLine}`);

                    // Adjust symbol line numbers
                    chunk.symbols.forEach(symbol => {
                        symbol.line += window.startLine;
                    });

                    allChunks.push(chunk);
                }

            } catch (error) {
                this.logger.warn(`TreeSitter parsing failed for window ${i}: ${error}`);
                allErrors.push(`Window ${i}: ${error}`);

                // Even if TreeSitter fails, create a semantic chunk for this window
                const fallbackChunk = this.createSemanticFallbackChunk(
                    window, filePath, relativePath, language, i
                );
                allChunks.push(fallbackChunk);
            }
        }

        // Step 4: Remove duplicates from overlapping windows
        const deduplicatedChunks = this.removeDuplicateChunks(allChunks);

        const processingTime = Date.now() - startTime;
        const avgChunkSize = deduplicatedChunks.reduce((sum, chunk) => sum + chunk.size, 0) / deduplicatedChunks.length || 0;

        this.logger.info(`✅ Intelligent range-based parsing complete: ${deduplicatedChunks.length} chunks, ${processingTime}ms`);

        return {
            chunks: deduplicatedChunks,
            parseErrors: allErrors,
            metadata: {
                totalNodes,
                totalChunks: deduplicatedChunks.length,
                averageChunkSize: avgChunkSize,
                processingTime
            }
        };
    }

    /**
     * Find semantic boundaries in code (class/function/interface starts)
     */
    /**
     * Create comprehensive chunks from a window ensuring full content coverage
     */
    private async createComprehensiveWindowChunks(
        rootNode: TreeSitterNode,
        windowContent: string,
        filePath: string,
        relativePath: string,
        language: string,
        windowIndex: number
    ): Promise<SemanticChunk[]> {
        const chunks: SemanticChunk[] = [];
        const lines = windowContent.split('\n');

        // First, find semantic units (functions, classes, etc.)
        const semanticUnits = this.findSemanticUnits(rootNode, windowContent);
        const coveredLines = new Set<number>();

        // Process semantic units first
        for (const unit of semanticUnits) {
            const chunk = await this.createChunkFromUnit(
                unit,
                windowContent,
                filePath,
                relativePath,
                language
            );

            if (chunk) {
                chunks.push(chunk);
                // Track which lines are covered
                for (let line = chunk.startLine; line <= chunk.endLine; line++) {
                    coveredLines.add(line);
                }
            }
        }

        // Find gaps and create chunks to fill them
        const gaps = this.findContentGaps(lines.length, coveredLines);

        for (const gap of gaps) {
            const gapContent = lines.slice(gap.start, gap.end + 1).join('\n');

            // Skip very small gaps (less than 3 lines) unless they contain meaningful content
            if (gap.end - gap.start < 2) {
                const hasContent = gapContent.trim().length > 50;
                if (!hasContent) continue;
            }

            // Create chunk for gap content
            const gapChunk = await this.createChunkFromContent(
                gapContent,
                gap.start,
                gap.end,
                filePath,
                relativePath,
                language,
                'gap_content'
            );

            if (gapChunk) {
                chunks.push(gapChunk);
            }
        }

        // Sort chunks by start line
        chunks.sort((a, b) => a.startLine - b.startLine);

        return chunks;
    }

    /**
     * Find gaps in line coverage
     */
    private findContentGaps(totalLines: number, coveredLines: Set<number>): Array<{start: number, end: number}> {
        const gaps: Array<{start: number, end: number}> = [];
        let gapStart = -1;

        for (let line = 0; line < totalLines; line++) {
            if (!coveredLines.has(line)) {
                if (gapStart === -1) {
                    gapStart = line;
                }
            } else {
                if (gapStart !== -1) {
                    gaps.push({start: gapStart, end: line - 1});
                    gapStart = -1;
                }
            }
        }

        // Handle gap at end
        if (gapStart !== -1) {
            gaps.push({start: gapStart, end: totalLines - 1});
        }

        return gaps;
    }

    /**
     * Create chunk from content string
     */
    private async createChunkFromContent(
        content: string,
        startLine: number,
        endLine: number,
        filePath: string,
        relativePath: string,
        language: string,
        chunkType: string
    ): Promise<SemanticChunk | null> {
        if (content.trim().length === 0) {
            return null;
        }

        // Extract symbols from content if possible
        const symbols: SemanticChunk['symbols'] = [];

        try {
            // Simple regex-based symbol extraction for gap content
            this.extractBasicSymbols(content, symbols, startLine);
        } catch (error) {
            // Continue without symbols if extraction fails
        }

        return {
            id: this.generateShortId(filePath, `${startLine}-${endLine}`),
            content: content.trim(),
            filePath,
            relativePath,
            startLine,
            endLine,
            language,
            chunkType: chunkType as SemanticChunk['chunkType'],
            size: content.length,
            complexity: 'low', // Simple default complexity
            symbols,
            imports: [] // TODO: Implement import extraction if needed
        };
    }

    /**
     * Extract basic symbols using simple patterns for gap content
     */
    private extractBasicSymbols(content: string, symbols: SemanticChunk['symbols'], baseLineNumber: number): void {
        const lines = content.split('\n');

        lines.forEach((line, i) => {
            const lineNumber = baseLineNumber + i;
            const trimmed = line.trim();

            // Function declarations
            const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            if (funcMatch) {
                symbols.push({
                    name: funcMatch[1],
                    type: 'function',
                    line: lineNumber
                });
            }

            // Class declarations
            const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
            if (classMatch) {
                symbols.push({
                    name: classMatch[1],
                    type: 'class',
                    line: lineNumber
                });
            }

            // Interface declarations
            const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
            if (interfaceMatch) {
                symbols.push({
                    name: interfaceMatch[1],
                    type: 'interface',
                    line: lineNumber
                });
            }

            // Type declarations
            const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
            if (typeMatch) {
                symbols.push({
                    name: typeMatch[1],
                    type: 'type',
                    line: lineNumber
                });
            }
        });
    }

    private findSemanticBoundaries(content: string): Array<{ line: number; type: string; name?: string }> {
        const lines = content.split('\n');
        const boundaries: Array<{ line: number; type: string; name?: string }> = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Major semantic boundaries
            if (line.match(/^(export\s+)?(class|interface|enum)\s+\w+/)) {
                const match = line.match(/^(export\s+)?(class|interface|enum)\s+(\w+)/);
                boundaries.push({
                    line: i,
                    type: match?.[2] || 'class',
                    name: match?.[3]
                });
            } else if (line.match(/^(export\s+)?(async\s+)?function\s+\w+/)) {
                const match = line.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
                boundaries.push({
                    line: i,
                    type: 'function',
                    name: match?.[3]
                });
            } else if (line.match(/^(export\s+)?(const|let|var)\s+\w+\s*=/)) {
                const match = line.match(/^(export\s+)?(const|let|var)\s+(\w+)/);
                boundaries.push({
                    line: i,
                    type: 'variable',
                    name: match?.[3]
                });
            }
        }

        return boundaries;
    }

    /**
     * Create intelligent windows that respect semantic boundaries
     */
    private createIntelligentWindows(
        content: string,
        boundaries: Array<{ line: number; type: string; name?: string }>,
        windowSize: number,
        overlapSize: number
    ): Array<{ content: string; startLine: number; endLine: number; startByte: number; endByte: number }> {
        const lines = content.split('\n');
        const windows: Array<{ content: string; startLine: number; endLine: number; startByte: number; endByte: number }> = [];

        let currentStart = 0;

        while (currentStart < lines.length) {
            // Find optimal end point respecting semantic boundaries
            let currentEnd = Math.min(currentStart + Math.floor(windowSize / 50), lines.length); // ~50 chars per line estimate

            // Adjust end to semantic boundary if possible
            const nearbyBoundary = boundaries.find(b =>
                b.line > currentEnd - 10 && b.line < currentEnd + 10
            );

            if (nearbyBoundary && nearbyBoundary.line < lines.length - 5) {
                currentEnd = nearbyBoundary.line;
            }

            const windowLines = lines.slice(currentStart, currentEnd);
            const windowContent = windowLines.join('\n');

            // Ensure window is under size limit
            if (windowContent.length > windowSize) {
                // Trim to size while preserving semantic integrity
                currentEnd = this.findSafeTrimPoint(lines, currentStart, windowSize);
                const trimmedContent = lines.slice(currentStart, currentEnd).join('\n');

                if (trimmedContent.length > 0) {
                    windows.push({
                        content: trimmedContent,
                        startLine: currentStart,
                        endLine: currentEnd,
                        startByte: this.calculateByteOffset(content, currentStart),
                        endByte: this.calculateByteOffset(content, currentEnd)
                    });
                }
            } else if (windowContent.length > 0) {
                windows.push({
                    content: windowContent,
                    startLine: currentStart,
                    endLine: currentEnd,
                    startByte: this.calculateByteOffset(content, currentStart),
                    endByte: this.calculateByteOffset(content, currentEnd)
                });
            }

            // Move to next window with meaningful overlap
            const overlapLines = Math.floor(overlapSize / 50); // ~40 lines for 2KB overlap
            const minIncrement = Math.max(50, Math.floor((currentEnd - currentStart) / 2)); // At least 50 lines or half window

            currentStart = Math.max(
                currentStart + minIncrement,
                currentEnd - overlapLines
            );

            // Prevent infinite loop and tiny windows at end
            if (currentStart >= currentEnd - 10 || currentEnd >= lines.length - 10) {
                break; // End processing to avoid tiny windows
            }
        }

        return windows;
    }

    private findSafeTrimPoint(lines: string[], start: number, maxSize: number): number {
        let size = 0;
        let lastSafeTrim = start;

        for (let i = start; i < lines.length; i++) {
            const lineSize = lines[i].length + 1; // +1 for newline
            if (size + lineSize > maxSize) break;

            size += lineSize;

            // Safe trim points: end of functions, classes, or natural breaks
            const line = lines[i].trim();
            if (line === '}' || line === '' || line.startsWith('//')) {
                lastSafeTrim = i + 1;
            }
        }

        return Math.max(lastSafeTrim, start + 1);
    }

    private calculateByteOffset(content: string, lineNumber: number): number {
        const lines = content.split('\n');
        let offset = 0;
        for (let i = 0; i < Math.min(lineNumber, lines.length); i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        return offset;
    }

    /**
     * Create a semantic fallback chunk when TreeSitter fails
     */
    private createSemanticFallbackChunk(
        window: { content: string; startLine: number; endLine: number },
        filePath: string,
        relativePath: string,
        language: string,
        windowIndex: number
    ): SemanticChunk {
        const symbols: SemanticChunk['symbols'] = [];

        // Use improved regex-based symbol extraction
        this.extractSymbolsFromContent(window.content, 'mixed', symbols, window.startLine + 1);

        return {
            id: this.generateShortId(filePath, `semantic_fallback_w${windowIndex}`),
            content: window.content,
            filePath,
            relativePath,
            startLine: window.startLine + 1,
            endLine: window.endLine,
            language,
            chunkType: 'mixed',
            symbols,
            imports: this.extractImportsFromContent(window.content),
            size: window.content.length,
            complexity: this.calculateComplexity(window.content)
        };
    }

    /**
     * Extract imports from content
     */
    private extractImportsFromContent(content: string): Array<{ module: string; symbols: string[]; line: number }> {
        const imports: Array<{ module: string; symbols: string[]; line: number }> = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('import ')) {
                const moduleMatch = line.match(/from\s+['"]([^'"]+)['"]/);
                const symbolsMatch = line.match(/import\s+\{([^}]+)\}/);

                imports.push({
                    module: moduleMatch?.[1] || 'unknown',
                    symbols: symbolsMatch?.[1]?.split(',').map(s => s.trim()) || [],
                    line: i + 1
                });
            }
        }

        return imports;
    }

    /**
     * Remove duplicate chunks from overlapping windows
     */
    private removeDuplicateChunks(chunks: SemanticChunk[]): SemanticChunk[] {
        const uniqueChunks: SemanticChunk[] = [];
        const seenRanges = new Set<string>();

        for (const chunk of chunks) {
            const rangeKey = `${chunk.startLine}-${chunk.endLine}-${chunk.chunkType}`;

            if (!seenRanges.has(rangeKey)) {
                seenRanges.add(rangeKey);
                uniqueChunks.push(chunk);
            }
        }

        return uniqueChunks;
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
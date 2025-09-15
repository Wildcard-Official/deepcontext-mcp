/**
 * IndexingOrchestrator - Core business logic for codebase indexing
 * 
 * Orchestrates the complete indexing process:
 * - File discovery and filtering
 * - Symbol extraction with AST parsing
 * - Chunk generation with dependency context
 * - Embedding generation and storage
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileUtils } from '../../utils/FileUtils.js';
import { LanguageDetector } from '../../utils/LanguageDetector.js';
import { ContentFilterProvider } from './ContentFilterProvider.js';
import { TreeSitterSymbolExtractorFull } from './TreeSitterSymbolExtractor.treesitter-based.js';
import { TreeSitterChunkExtractor, SemanticChunk } from './TreeSitterChunkExtractor.js';
import { Logger } from '../../utils/Logger.js';

export interface IndexingRequest {
    codebasePath: string;
    force?: boolean;
    enableDependencyAnalysis?: boolean;
    enableContentFiltering?: boolean;
    maxChunkSize?: number;
    maxChunkLines?: number;
    supportedLanguages?: string[];
}

export interface CodeChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
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
}

export interface IndexingResult {
    success: boolean;
    metadata: {
        codebasePath: string;
        namespace: string;
        totalFiles: number;
        totalChunks: number;
        totalSymbols: number;
        indexingTime: number;
        indexingMethod: 'full' | 'incremental';
        features: {
            astExtraction: boolean;
            contentFiltering: boolean;
            dependencyAnalysis: boolean;
            incrementalUpdate: boolean;
        };
    };
    chunks: CodeChunk[];
    errors: Array<{ file: string; error: string }>;
}

export interface IndexingServices {
    jinaApiService?: any; // JinaApiService 
    turbopufferService?: any; // TurbopufferService
    metadataCallback?: (codebasePath: string, indexedData: any) => Promise<void>;
}

export class IndexingOrchestrator {
    private fileUtils: FileUtils;
    private languageDetector: LanguageDetector;
    private contentFilter: ContentFilterProvider;
    private symbolExtractor: TreeSitterSymbolExtractorFull;
    private chunkExtractor: TreeSitterChunkExtractor;
    private logger: Logger;
    private services?: IndexingServices;

    constructor(services?: IndexingServices) {
        this.fileUtils = new FileUtils();
        this.languageDetector = new LanguageDetector();
        this.contentFilter = new ContentFilterProvider();
        this.symbolExtractor = new TreeSitterSymbolExtractorFull();
        this.chunkExtractor = new TreeSitterChunkExtractor();
        this.logger = new Logger('INDEXING-ORCHESTRATOR', 'info');
        this.services = services;
    }

    /**
     * Main indexing orchestration method
     */
    async indexCodebase(request: IndexingRequest): Promise<IndexingResult> {
        const startTime = Date.now();
        const errors: Array<{ file: string; error: string }> = [];
        
        this.logger.info(`🚀 Starting indexing: ${request.codebasePath}`);
        this.logger.debug(`📋 Options: ${JSON.stringify({
            force: request.force,
            filtering: request.enableContentFiltering,
            dependencies: request.enableDependencyAnalysis
        })}`);

        try {
            // Step 1: Discover files
            this.logger.debug(`🔍 Starting file discovery for: ${request.codebasePath}`);
            const allFiles = await this.fileUtils.discoverFiles(
                request.codebasePath,
                request.supportedLanguages || ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust']
            );
            this.logger.debug(`📁 Discovered: ${allFiles.length} files`);

            if (allFiles.length === 0) {
                this.logger.warn(`⚠️ No files found in ${request.codebasePath}`);
                errors.push({
                    file: request.codebasePath,
                    error: 'No supported files found in directory'
                });
            }

            // Step 2: Apply content filtering
            this.logger.debug(`🔍 Starting content filtering...`);
            let filesToProcess = allFiles;
            if (request.enableContentFiltering !== false) {
                filesToProcess = await this.applyContentFiltering(allFiles, request.codebasePath);
                this.logger.debug(`🔍 After filtering: ${filesToProcess.length} files`);
            }

            this.logger.info(`📝 Processing: ${filesToProcess.length} files`);

            // Step 3: Process files in batches
            const chunks: CodeChunk[] = [];
            const batchSize = 10;
            
            for (let i = 0; i < filesToProcess.length; i += batchSize) {
                const batch = filesToProcess.slice(i, i + batchSize);
                const batchResults = await Promise.allSettled(
                    batch.map(file => this.processFile(file, request))
                );

                // Collect results and errors
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        chunks.push(...result.value);
                    } else {
                        errors.push({
                            file: batch[index],
                            error: result.reason?.message || 'Unknown error'
                        });
                    }
                });

                this.logger.debug(`📊 Processed: ${Math.min(i + batchSize, filesToProcess.length)}/${filesToProcess.length} files`);
            }

            const indexingTime = Date.now() - startTime;
            const namespace = this.generateNamespace(request.codebasePath);
            
            // Upload to vector store if services are provided
            if (this.services?.jinaApiService && this.services?.turbopufferService && chunks.length > 0) {
                this.logger.info(`Uploading ${chunks.length} chunks to vector store...`);
                await this.uploadChunksToVectorStore(namespace, chunks);
                
                // Call metadata callback if provided
                if (this.services.metadataCallback) {
                    const indexedData = {
                        namespace,
                        totalChunks: chunks.length,
                        indexedAt: new Date().toISOString()
                    };
                    await this.services.metadataCallback(request.codebasePath, indexedData);
                }
            }
            
            this.logger.info(`✅ Complete: ${chunks.length} chunks in ${indexingTime}ms`);

            return {
                success: true,
                metadata: {
                    codebasePath: request.codebasePath,
                    namespace,
                    totalFiles: filesToProcess.length,
                    totalChunks: chunks.length,
                    totalSymbols: chunks.reduce((sum, chunk) => sum + chunk.symbols.length, 0),
                    indexingTime,
                    indexingMethod: 'full',
                    features: {
                        astExtraction: true,
                        contentFiltering: request.enableContentFiltering !== false,
                        dependencyAnalysis: request.enableDependencyAnalysis !== false,
                        incrementalUpdate: false
                    }
                },
                chunks,
                errors
            };

        } catch (error) {
            console.error('[INDEXING] ❌ Fatal error:', error);
            return {
                success: false,
                metadata: {
                    codebasePath: request.codebasePath,
                    namespace: this.generateNamespace(request.codebasePath),
                    totalFiles: 0,
                    totalChunks: 0,
                    totalSymbols: 0,
                    indexingTime: Date.now() - startTime,
                    indexingMethod: 'full',
                    features: {
                        astExtraction: false,
                        contentFiltering: false,
                        dependencyAnalysis: false,
                        incrementalUpdate: false
                    }
                },
                chunks: [],
                errors: [{ file: 'system', error: error instanceof Error ? error.message : String(error) }]
            };
        }
    }

    /**
     * Process a single file into semantic chunks using Tree-sitter AST parsing
     * Uses TreeSitterChunkExtractor for meaningful code unit extraction
     */
    public async processFile(filePath: string, request: IndexingRequest): Promise<CodeChunk[]> {
        const content = await fs.readFile(filePath, 'utf-8');
        const language = this.languageDetector.detectLanguage(filePath, content);
        const relativePath = path.relative(request.codebasePath, filePath);

        try {
            // Use new TreeSitterChunkExtractor for semantic chunking
            const chunkingResult = await this.chunkExtractor.extractSemanticChunks(
                content,
                language.language,
                filePath,
                relativePath
            );

            // Convert SemanticChunk[] to CodeChunk[] format
            const chunks: CodeChunk[] = chunkingResult.chunks.map(semanticChunk => ({
                id: semanticChunk.id,
                content: semanticChunk.content,
                filePath: semanticChunk.filePath,
                relativePath: semanticChunk.relativePath,
                startLine: semanticChunk.startLine,
                endLine: semanticChunk.endLine,
                language: semanticChunk.language,
                symbols: semanticChunk.symbols.map(symbol => ({
                    name: symbol.name,
                    type: symbol.type as any,
                    line: symbol.line,
                    scope: symbol.scope
                })),
                imports: semanticChunk.imports
            }));

            this.logger.debug(`Created ${chunks.length} semantic chunks for ${filePath}`);
            
            // Log chunk details for debugging
            if (chunks.length > 0) {
                const avgSize = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0) / chunks.length;
                this.logger.debug(`Average chunk size: ${avgSize.toFixed(0)} characters`);
            }

            return chunks;

        } catch (error) {
            // Fallback to simpler chunking if semantic chunking fails
            this.logger.warn(`Semantic chunking failed for ${filePath}, using fallback: ${error}`);
            return this.createFallbackChunks(content, filePath, relativePath, language.language);
        }
    }

    /**
     * Create chunks from documentable nodes (complete logical units)
     * Each node becomes one chunk with complete boundaries and context
     */
    private createDocumentableNodeChunks(
        filePath: string,
        relativePath: string,
        language: string,
        nodeAnalysis: any,
        request: IndexingRequest
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const maxChunkSize = request.maxChunkSize || 8000; // Increased for complete functions
        const maxChunkLines = request.maxChunkLines || 300;

        for (const node of nodeAnalysis.nodes) {
            // Check if node needs hierarchical chunking
            const needsHierarchicalChunking = 
                node.content.length > maxChunkSize || 
                (node.endLine - node.startLine) > maxChunkLines;

            if (needsHierarchicalChunking && node.type === 'class') {
                // Apply hierarchical chunking to large classes
                const hierarchicalChunks = this.createHierarchicalClassChunks(
                    node, filePath, relativePath, language
                );
                chunks.push(...hierarchicalChunks);
                this.logger.debug(`Created ${hierarchicalChunks.length} hierarchical chunks for class ${node.name}`);
            } else {
                // Create single chunk for smaller nodes
                const symbols = [{
                    name: node.name,
                    type: node.type === 'method' ? 'function' : node.type,
                    line: node.startLine,
                    scope: node.scope
                }];

                const imports = node.imports.map((importPath: string) => ({
                    module: importPath,
                    symbols: [],
                    line: 1
                }));

                chunks.push({
                    id: this.generateChunkId(filePath, node.startLine, node.content),
                    content: node.content,
                    filePath,
                    relativePath,
                    startLine: node.startLine,
                    endLine: node.endLine,
                    language,
                    symbols,
                    imports
                });
            }
        }

        this.logger.debug(`Created ${chunks.length} documentable node chunks for ${filePath}`);
        return chunks;
    }

    /**
     * Create hierarchical chunks for large classes
     * Splits large classes into: class overview + individual methods
     */
    private createHierarchicalClassChunks(
        node: any,
        filePath: string,
        relativePath: string,
        language: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const lines = node.content.split('\n');
        
        // Create class overview chunk (first ~50 lines or until first method)
        const overviewEndLine = this.findClassOverviewEnd(lines);
        const overviewContent = lines.slice(0, overviewEndLine + 1).join('\n');
        
        chunks.push({
            id: this.generateChunkId(filePath, node.startLine, overviewContent),
            content: overviewContent,
            filePath,
            relativePath,
            startLine: node.startLine,
            endLine: node.startLine + overviewEndLine,
            language,
            symbols: [{
                name: node.name,
                type: 'class',
                line: node.startLine,
                scope: node.scope
            }],
            imports: node.imports.map((importPath: string) => ({
                module: importPath,
                symbols: [],
                line: 1
            }))
        });

        // Extract individual methods from the remaining content
        const methodChunks = this.extractMethodsFromClass(
            lines.slice(overviewEndLine + 1),
            node,
            filePath,
            relativePath,
            language,
            node.startLine + overviewEndLine + 1
        );
        
        chunks.push(...methodChunks);
        return chunks;
    }

    /**
     * Find where class overview should end (after constructor, before first real method)
     */
    private findClassOverviewEnd(lines: string[]): number {
        let constructorEnd = -1;
        
        // First, find the end of constructor if it exists
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('constructor')) {
                // Find the end of constructor
                constructorEnd = this.findMethodEndInLines(lines, i);
                break;
            }
        }
        
        // If we found constructor, look for first method after it
        const searchStart = Math.max(constructorEnd + 1, 0);
        for (let i = searchStart; i < Math.min(lines.length, 80); i++) {
            const line = lines[i].trim();
            // Look for method patterns (but not constructor)
            if (line.match(/^\s*(public|private|protected)?\s*(async\s+)?\w+\s*\(/)) {
                if (!line.includes('constructor')) {
                    return Math.max(i - 1, constructorEnd + 1); // Include line before method
                }
            }
        }
        
        // Default: include constructor + some buffer, or first 50 lines
        return Math.min(constructorEnd + 5, 49, lines.length - 1);
    }

    /**
     * Extract individual methods from class content
     */
    private extractMethodsFromClass(
        lines: string[],
        classNode: any,
        filePath: string,
        relativePath: string,
        language: string,
        startLineOffset: number
    ): CodeChunk[] {
        const methods: CodeChunk[] = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i].trim();
            
            // Look for method declarations
            const methodMatch = line.match(/^\s*(public|private|protected)?\s*(async\s+)?(\w+)\s*\(/);
            if (methodMatch) {
                const methodName = methodMatch[3];
                const methodStart = i;
                const methodEnd = this.findMethodEnd(lines, i);
                
                if (methodEnd > methodStart) {
                    // Find preceding comments (JSDoc, etc.)
                    const commentStart = this.findPrecedingComments(lines, methodStart);
                    const methodContent = lines.slice(commentStart, methodEnd + 1).join('\n');
                    
                    methods.push({
                        id: this.generateChunkId(filePath, startLineOffset + commentStart, methodContent),
                        content: methodContent,
                        filePath,
                        relativePath,
                        startLine: startLineOffset + commentStart,
                        endLine: startLineOffset + methodEnd,
                        language,
                        symbols: [{
                            name: `${classNode.name}.${methodName}`,
                            type: 'function',
                            line: startLineOffset + methodStart,
                            scope: classNode.scope
                        }],
                        imports: classNode.imports.map((importPath: string) => ({
                            module: importPath,
                            symbols: [],
                            line: 1
                        }))
                    });
                }
                
                i = methodEnd + 1;
            } else {
                i++;
            }
        }
        
        return methods;
    }

    /**
     * Find the end of a method using brace matching (helper for hierarchical chunking)
     */
    private findMethodEndInLines(lines: string[], startIndex: number): number {
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
                        return i;
                    }
                }
            }
        }
        
        return startIndex; // Fallback if no matching brace found
    }

    /**
     * Find the end of a method using brace matching
     */
    private findMethodEnd(lines: string[], startIndex: number): number {
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
                        return i;
                    }
                }
            }
        }
        
        return startIndex; // Fallback if no matching brace found
    }

    /**
     * Find preceding comments (JSDoc, block comments, etc.)
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
     * Create chunks based on symbol boundaries (fallback)
     */
    private createSymbolBasedChunks(
        content: string,
        filePath: string,
        relativePath: string,
        language: string,
        symbolAnalysis: any,
        request: IndexingRequest
    ): CodeChunk[] {
        const lines = content.split('\n');
        const maxChunkSize = request.maxChunkSize || 2000;
        const maxChunkLines = request.maxChunkLines || 100;
        const chunks: CodeChunk[] = [];

        // Group symbols by logical boundaries
        const symbolGroups = this.groupSymbolsByBoundaries(symbolAnalysis.symbols, lines);

        for (const group of symbolGroups) {
            const chunkContent = lines.slice(group.startLine - 1, group.endLine).join('\n');
            
            // Skip if chunk is too large (probably generated code)
            if (chunkContent.length > maxChunkSize * 2 || group.endLine - group.startLine > maxChunkLines * 2) {
                continue;
            }

            chunks.push({
                id: this.generateChunkId(filePath, group.startLine, chunkContent),
                content: chunkContent,
                filePath,
                relativePath,
                startLine: group.startLine,
                endLine: group.endLine,
                language,
                symbols: group.symbols,
                imports: symbolAnalysis.imports.filter((imp: any) => 
                    imp.line >= group.startLine && imp.line <= group.endLine
                )
            });
        }

        return chunks;
    }

    /**
     * Group symbols into logical chunks
     */
    private groupSymbolsByBoundaries(symbols: any[], lines: string[]): Array<{
        startLine: number;
        endLine: number;
        symbols: any[];
    }> {
        if (symbols.length === 0) {
            // No symbols, create simple line-based chunks
            const groups = [];
            let currentStart = 1;
            
            while (currentStart <= lines.length) {
                const endLine = Math.min(currentStart + 50, lines.length);
                groups.push({
                    startLine: currentStart,
                    endLine,
                    symbols: []
                });
                currentStart = endLine + 1;
            }
            
            return groups;
        }

        // Group symbols by proximity
        const groups = [];
        let currentGroup = {
            startLine: symbols[0].startLine || symbols[0].line,
            endLine: symbols[0].endLine || symbols[0].line,
            symbols: [symbols[0]]
        };

        for (let i = 1; i < symbols.length; i++) {
            const symbol = symbols[i];
            const symbolStart = symbol.startLine || symbol.line;
            const symbolEnd = symbol.endLine || symbol.line;

            // If symbol is within reasonable distance, add to current group
            if (symbolStart - currentGroup.endLine <= 10) {
                currentGroup.endLine = Math.max(currentGroup.endLine, symbolEnd);
                currentGroup.symbols.push(symbol);
            } else {
                // Start new group
                groups.push(currentGroup);
                currentGroup = {
                    startLine: symbolStart,
                    endLine: symbolEnd,
                    symbols: [symbol]
                };
            }
        }

        groups.push(currentGroup);
        return groups;
    }

    private async applyContentFiltering(files: string[], codebasePath: string): Promise<string[]> {
        const filtered: string[] = [];
        
        for (const file of files) {
            try {
                const content = await fs.readFile(file, 'utf-8');
                const relativePath = path.relative(codebasePath, file);
                
                const shouldInclude = this.contentFilter.shouldInclude(relativePath, content);
                if (shouldInclude.include) {
                    filtered.push(file);
                } else {
                    this.logger.debug(`🚫 Filtered: ${relativePath} (${shouldInclude.reason})`);
                }
            } catch (error) {
                console.warn(`[INDEXING] ⚠️ Error filtering ${file}: ${error}`);
            }
        }
        
        return filtered;
    }



    private generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 8)}`;
    }

    /**
     * Upload chunks to vector store with embedding generation
     */
    private async uploadChunksToVectorStore(namespace: string, chunks: CodeChunk[]): Promise<void> {
        if (!chunks.length || !this.services?.jinaApiService || !this.services?.turbopufferService) {
            return;
        }
        
        this.logger.info(`Uploading ${chunks.length} chunks to vector store and local metadata...`);
        
        const batchSize = 50;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            
            // Generate embeddings for batch
            const embeddings = await this.services.jinaApiService.generateEmbeddingBatch(
                batch.map(chunk => chunk.content)
            );
            
            // Prepare upsert data in Turbopuffer v2 format with schema for full-text search
            const upsertData = batch.map((chunk, idx) => ({
                id: chunk.id,
                vector: embeddings[idx],
                content: chunk.content,
                filePath: chunk.filePath,
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: chunk.language,
                symbols: chunk.symbols.map(s => typeof s === 'string' ? s : s.name).join(',')
            }));
            
            // Upload to Turbopuffer
            await this.services.turbopufferService.upsert(namespace, upsertData);
        }
        
        this.logger.info(`✅ Uploaded ${chunks.length} chunks to namespace: ${namespace}`);
    }

    /**
     * Create sensible fallback chunks when semantic parsing fails
     * Unlike the broken single-line approach, this creates larger, meaningful chunks
     */
    private createFallbackChunks(
        content: string,
        filePath: string,
        relativePath: string,
        language: string
    ): CodeChunk[] {
        const lines = content.split('\n');
        const chunks: CodeChunk[] = [];
        const chunkSize = 100; // 100 lines per chunk (not 1!)
        
        for (let i = 0; i < lines.length; i += chunkSize) {
            const startLine = i + 1;
            const endLine = Math.min(i + chunkSize, lines.length);
            const chunkLines = lines.slice(i, endLine);
            const chunkContent = chunkLines.join('\n');
            
            // Skip empty chunks
            if (!chunkContent.trim()) continue;
            
            chunks.push({
                id: this.generateChunkId(filePath, startLine, chunkContent),
                content: chunkContent,
                filePath,
                relativePath,
                startLine,
                endLine,
                language,
                symbols: [], // No symbols for fallback chunks
                imports: [] // No imports for fallback chunks
            });
        }
        
        return chunks;
    }

    /**
     * Expand symbol to include complete logical unit (function body, class body, etc.)
     * This provides simple but effective boundary expansion for symbols
     */
    private expandSymbolToLogicalUnit(
        symbol: any,
        lines: string[],
        content: string
    ): { startLine: number; endLine: number; symbolContent: string } {
        const declarationLine = symbol.startLine - 1; // Convert to 0-based

        if (declarationLine < 0 || declarationLine >= lines.length) {
            const fallbackContent = lines[symbol.startLine - 1] || '';
            return { 
                startLine: symbol.startLine, 
                endLine: symbol.startLine, 
                symbolContent: fallbackContent 
            };
        }

        const line = lines[declarationLine].trim();
        let startIdx = declarationLine;
        let endIdx = declarationLine;

        // Find preceding comments
        while (startIdx > 0) {
            const prevLine = lines[startIdx - 1].trim();
            if (prevLine === '' || prevLine.startsWith('//') || prevLine.startsWith('/*') || 
                prevLine.startsWith('*') || prevLine.includes('*/')) {
                startIdx--;
            } else {
                break;
            }
        }

        // Expand based on symbol type
        if (symbol.type === 'class' || symbol.type === 'interface') {
            endIdx = this.findBlockEnd(declarationLine, lines);
        } else if (symbol.type === 'function' || line.includes('=>')) {
            if (line.includes('{')) {
                endIdx = this.findBlockEnd(declarationLine, lines);
            } else {
                // Simple arrow function or single line
                endIdx = this.findStatementEnd(declarationLine, lines);
            }
        } else {
            // Variable, type, etc. - find statement end
            endIdx = this.findStatementEnd(declarationLine, lines);
        }

        const symbolContent = lines.slice(startIdx, endIdx + 1).join('\n');
        return { 
            startLine: startIdx + 1,  // Convert back to 1-based
            endLine: endIdx + 1, 
            symbolContent 
        };
    }

    /**
     * Find block end using brace matching
     */
    private findBlockEnd(startLineIndex: number, lines: string[]): number {
        let braceCount = 0;
        let foundOpenBrace = false;
        
        for (let i = startLineIndex; i < lines.length; i++) {
            const line = lines[i];
            
            for (const char of line) {
                if (char === '{') {
                    braceCount++;
                    foundOpenBrace = true;
                } else if (char === '}') {
                    braceCount--;
                    if (foundOpenBrace && braceCount === 0) {
                        return i;
                    }
                }
            }
        }
        
        return Math.min(startLineIndex + 50, lines.length - 1);
    }

    /**
     * Find statement end (for variables, simple functions, etc.)
     */
    private findStatementEnd(startLineIndex: number, lines: string[]): number {
        let parenCount = 0;
        let braceCount = 0;
        let bracketCount = 0;
        
        for (let i = startLineIndex; i < lines.length; i++) {
            const line = lines[i];
            
            // Count brackets
            for (const char of line) {
                switch (char) {
                    case '(': parenCount++; break;
                    case ')': parenCount--; break;
                    case '{': braceCount++; break;
                    case '}': braceCount--; break;
                    case '[': bracketCount++; break;
                    case ']': bracketCount--; break;
                }
            }
            
            // Check if statement is complete
            const trimmedLine = line.trim();
            if ((parenCount === 0 && braceCount === 0 && bracketCount === 0) &&
                (trimmedLine.endsWith(';') || trimmedLine.endsWith('}') || 
                 trimmedLine.endsWith(');'))) {
                return i;
            }
            
            // Safety: stop at next declaration or max lines
            if (i > startLineIndex && 
                (trimmedLine.match(/^(const|let|var|function|class|interface|type)\s+/) ||
                 i - startLineIndex > 20)) {
                return i - 1;
            }
        }
        
        return Math.min(startLineIndex + 20, lines.length - 1);
    }

    private generateChunkId(filePath: string, startLine: number, content: string): string {
        const input = `${filePath}:${startLine}:${content}`;
        const hash = crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    /**
     * Get indexing status for codebases
     */
    async getIndexingStatus(
        indexedCodebases: Map<string, any>, 
        codebasePath?: string
    ): Promise<{
        indexedCodebases: any[];
        currentCodebase?: any;
        incrementalStats?: any;
        indexed: boolean;
        fileCount: number;
    }> {
        const indexedList = Array.from(indexedCodebases.values());
        
        let currentCodebase: any | undefined;
        let incrementalStats: any;
        
        if (codebasePath) {
            try {
                const normalizedPath = path.resolve(codebasePath);
                await fs.access(normalizedPath);
                currentCodebase = indexedCodebases.get(normalizedPath);
            } catch (error) {
                return {
                    indexedCodebases: indexedList,
                    indexed: false,
                    fileCount: 0
                };
            }
            
            if (currentCodebase) {
                incrementalStats = {
                    indexingMethod: 'full',
                    lastIndexed: currentCodebase.indexedAt
                };
            }
        }

        const indexed = codebasePath ? !!currentCodebase : indexedList.length > 0;
        const fileCount = currentCodebase?.totalChunks || indexedList.reduce((sum: number, cb: any) => sum + cb.totalChunks, 0);

        return {
            indexedCodebases: indexedList,
            currentCodebase,
            incrementalStats,
            indexed,
            fileCount
        };
    }

    /**
     * Clear index for codebase(s)
     */
    async clearIndex(
        indexedCodebases: Map<string, any>,
        codebasePath?: string,
        saveCallback?: () => Promise<void>
    ): Promise<{
        success: boolean;
        message: string;
        clearedNamespaces: string[];
    }> {
        try {
            const namespacesToClear: string[] = [];
            
            if (codebasePath) {
                const indexed = indexedCodebases.get(codebasePath);
                if (indexed) {
                    namespacesToClear.push(indexed.namespace);
                    indexedCodebases.delete(codebasePath);
                }
            } else {
                for (const indexed of indexedCodebases.values()) {
                    namespacesToClear.push(indexed.namespace);
                }
                indexedCodebases.clear();
            }

            // Clear from vector store if service available
            if (this.services?.turbopufferService) {
                for (const namespace of namespacesToClear) {
                    await this.services.turbopufferService.clearNamespace(namespace);
                }
            }

            // Save state if callback provided
            if (saveCallback) {
                await saveCallback();
            }
            
            return {
                success: true,
                message: `Cleared ${namespacesToClear.length} namespace(s)`,
                clearedNamespaces: namespacesToClear
            };
            
        } catch (error) {
            this.logger.error('Clear index failed:', error);
            return {
                success: false,
                message: `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
                clearedNamespaces: []
            };
        }
    }
}
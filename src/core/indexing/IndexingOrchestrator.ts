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
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor.js';
import { IncrementalIndexer } from './IncrementalIndexer.js';

export interface IndexingRequest {
    codebasePath: string;
    force?: boolean;
    enableDependencyAnalysis?: boolean;
    enableContentFiltering?: boolean;
    enableIncrementalUpdate?: boolean;
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
    dependencies: string[];  // Files this chunk depends on
    dependents: string[];    // Files that depend on this chunk
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

export class IndexingOrchestrator {
    private fileUtils: FileUtils;
    private languageDetector: LanguageDetector;
    private contentFilter: ContentFilterProvider;
    private symbolExtractor: TreeSitterSymbolExtractor;
    private incrementalIndexer: IncrementalIndexer;

    constructor() {
        this.fileUtils = new FileUtils();
        this.languageDetector = new LanguageDetector();
        this.contentFilter = new ContentFilterProvider();
        this.symbolExtractor = new TreeSitterSymbolExtractor();
        this.incrementalIndexer = new IncrementalIndexer();
    }

    /**
     * Main indexing orchestration method
     */
    async indexCodebase(request: IndexingRequest): Promise<IndexingResult> {
        const startTime = Date.now();
        const errors: Array<{ file: string; error: string }> = [];
        
        console.log(`[INDEXING] 🚀 Starting indexing: ${request.codebasePath}`);
        console.log(`[INDEXING] 📋 Options: ${JSON.stringify({
            force: request.force,
            incremental: request.enableIncrementalUpdate,
            filtering: request.enableContentFiltering,
            dependencies: request.enableDependencyAnalysis
        })}`);

        try {
            // Step 1: Determine indexing strategy (full vs incremental)
            const indexingMethod = await this.determineIndexingMethod(request);
            console.log(`[INDEXING] 📊 Method: ${indexingMethod}`);

            // Step 2: Discover files
            const allFiles = await this.fileUtils.discoverFiles(
                request.codebasePath,
                request.supportedLanguages || ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust']
            );
            console.log(`[INDEXING] 📁 Discovered: ${allFiles.length} files`);

            // Step 3: Apply content filtering
            let filesToProcess = allFiles;
            if (request.enableContentFiltering !== false) {
                filesToProcess = await this.applyContentFiltering(allFiles, request.codebasePath);
                console.log(`[INDEXING] 🔍 After filtering: ${filesToProcess.length} files`);
            }

            // Step 4: Determine which files need processing (for incremental)
            const filesToUpdate = indexingMethod === 'incremental' 
                ? await this.incrementalIndexer.getFilesToUpdate(filesToProcess, request.codebasePath)
                : filesToProcess;
            
            if (filesToUpdate.length === 0) {
                console.log('[INDEXING] ⚡ No files need updating');
                return this.createNoUpdateResult(request, startTime);
            }

            console.log(`[INDEXING] 📝 Processing: ${filesToUpdate.length} files`);

            // Step 5: Process files in batches
            const chunks: CodeChunk[] = [];
            const batchSize = 10;
            
            for (let i = 0; i < filesToUpdate.length; i += batchSize) {
                const batch = filesToUpdate.slice(i, i + batchSize);
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

                console.log(`[INDEXING] 📊 Processed: ${Math.min(i + batchSize, filesToUpdate.length)}/${filesToUpdate.length} files`);
            }

            // Step 6: Build cross-file dependencies if enabled
            if (request.enableDependencyAnalysis !== false && chunks.length > 0) {
                console.log('[INDEXING] 🔗 Building dependency graph...');
                await this.buildDependencyRelationships(chunks);
            }

            // Step 7: Update incremental index metadata
            if (indexingMethod === 'incremental') {
                await this.incrementalIndexer.updateIndexMetadata(
                    request.codebasePath,
                    filesToUpdate,
                    chunks
                );
            }

            const indexingTime = Date.now() - startTime;
            console.log(`[INDEXING] ✅ Complete: ${chunks.length} chunks in ${indexingTime}ms`);

            return {
                success: true,
                metadata: {
                    codebasePath: request.codebasePath,
                    namespace: this.generateNamespace(request.codebasePath),
                    totalFiles: filesToUpdate.length,
                    totalChunks: chunks.length,
                    totalSymbols: chunks.reduce((sum, chunk) => sum + chunk.symbols.length, 0),
                    indexingTime,
                    indexingMethod,
                    features: {
                        astExtraction: true,
                        contentFiltering: request.enableContentFiltering !== false,
                        dependencyAnalysis: request.enableDependencyAnalysis !== false,
                        incrementalUpdate: request.enableIncrementalUpdate !== false
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
     * Process a single file into chunks
     */
    private async processFile(filePath: string, request: IndexingRequest): Promise<CodeChunk[]> {
        const content = await fs.readFile(filePath, 'utf-8');
        const language = this.languageDetector.detectLanguage(filePath, content);
        const relativePath = path.relative(request.codebasePath, filePath);

        // Extract symbols using Tree-sitter
        const symbolAnalysis = await this.symbolExtractor.extractSymbols(
            content, 
            language.language, 
            filePath
        );

        // Create chunks based on symbol boundaries
        const chunks = this.createSymbolBasedChunks(
            content,
            filePath,
            relativePath,
            language.language,
            symbolAnalysis,
            request
        );

        return chunks;
    }

    /**
     * Create chunks based on symbol boundaries
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
                ),
                dependencies: [], // Will be filled by buildDependencyRelationships
                dependents: []    // Will be filled by buildDependencyRelationships
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

    private async determineIndexingMethod(request: IndexingRequest): Promise<'full' | 'incremental'> {
        if (request.force) return 'full';
        if (request.enableIncrementalUpdate === false) return 'full';
        
        const hasExistingIndex = await this.incrementalIndexer.hasExistingIndex(request.codebasePath);
        return hasExistingIndex ? 'incremental' : 'full';
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
                    console.log(`[INDEXING] 🚫 Filtered: ${relativePath} (${shouldInclude.reason})`);
                }
            } catch (error) {
                console.warn(`[INDEXING] ⚠️ Error filtering ${file}: ${error}`);
            }
        }
        
        return filtered;
    }

    private async buildDependencyRelationships(chunks: CodeChunk[]): Promise<void> {
        // Build a map of exports to files
        const exportMap = new Map<string, CodeChunk>();
        const importMap = new Map<string, CodeChunk[]>();

        for (const chunk of chunks) {
            // Map exports
            chunk.symbols.forEach(symbol => {
                if (symbol.scope === 'export' || symbol.type === 'function' || symbol.type === 'class') {
                    exportMap.set(symbol.name, chunk);
                }
            });

            // Map imports
            chunk.imports.forEach(imp => {
                imp.symbols.forEach(symbol => {
                    if (!importMap.has(symbol)) {
                        importMap.set(symbol, []);
                    }
                    importMap.get(symbol)!.push(chunk);
                });
            });
        }

        // Build relationships
        for (const chunk of chunks) {
            chunk.imports.forEach(imp => {
                imp.symbols.forEach(importedSymbol => {
                    const exportingChunk = exportMap.get(importedSymbol);
                    if (exportingChunk && exportingChunk !== chunk) {
                        // This chunk depends on the exporting chunk
                        if (!chunk.dependencies.includes(exportingChunk.filePath)) {
                            chunk.dependencies.push(exportingChunk.filePath);
                        }
                        
                        // The exporting chunk has this chunk as a dependent
                        if (!exportingChunk.dependents.includes(chunk.filePath)) {
                            exportingChunk.dependents.push(chunk.filePath);
                        }
                    }
                });
            });
        }
    }

    private createNoUpdateResult(request: IndexingRequest, startTime: number): IndexingResult {
        return {
            success: true,
            metadata: {
                codebasePath: request.codebasePath,
                namespace: this.generateNamespace(request.codebasePath),
                totalFiles: 0,
                totalChunks: 0,
                totalSymbols: 0,
                indexingTime: Date.now() - startTime,
                indexingMethod: 'incremental',
                features: {
                    astExtraction: true,
                    contentFiltering: request.enableContentFiltering !== false,
                    dependencyAnalysis: request.enableDependencyAnalysis !== false,
                    incrementalUpdate: true
                }
            },
            chunks: [],
            errors: []
        };
    }

    private generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 8)}`;
    }

    private generateChunkId(filePath: string, startLine: number, content: string): string {
        const input = `${filePath}:${startLine}:${content}`;
        const hash = crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }
}
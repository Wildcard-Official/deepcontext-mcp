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
import { ConfigurationService } from '../../services/ConfigurationService.js';
import { Logger } from '../../utils/Logger.js';
import { CodeChunk, IndexingRequest } from '../../types/core.js';


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
    namespaceManagerService?: any; // NamespaceManagerService
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
        // Create a default configuration service for now - ideally this should be injected
        const defaultConfigService = new ConfigurationService();
        this.chunkExtractor = new TreeSitterChunkExtractor(defaultConfigService);
        this.logger = new Logger('INDEXING-ORCHESTRATOR', 'debug');
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
            force: request.forceReindex,
            filtering: request.enableContentFiltering,
            dependencies: request.enableDependencyAnalysis
        })}`);

        try {
            // Initialize symbol extractor if not already initialized
            await this.symbolExtractor.initialize();

            // Step 1: Discover files
            const allFiles = await this.fileUtils.discoverFiles(
                request.codebasePath,
                request.supportedLanguages || ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust']
            );

            if (allFiles.length === 0) {
                this.logger.warn(`⚠️ No files found in ${request.codebasePath}`);
                errors.push({
                    file: request.codebasePath,
                    error: 'No supported files found in directory'
                });
            }

            // Step 2: Apply content filtering
            let filesToProcess = allFiles;
            if (request.enableContentFiltering !== false) {
                filesToProcess = await this.applyContentFiltering(allFiles, request.codebasePath);
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
            if (!this.services?.namespaceManagerService) {
                throw new Error('NamespaceManagerService is required for indexing operations');
            }
            const namespace = this.services.namespaceManagerService.generateNamespace(request.codebasePath);

            // Clear existing index if force reindex is requested
            if (request.forceReindex && this.services?.turbopufferService) {
                this.logger.info(`🗑️ Force reindex enabled - clearing existing namespace: ${namespace}`);
                try {
                    await this.services.turbopufferService.clearNamespace(namespace);
                    this.logger.info(`✅ Successfully cleared namespace: ${namespace}`);
                } catch (error) {
                    this.logger.warn(`⚠️ Failed to clear namespace ${namespace}:`, error);
                    // Continue with indexing even if clearing fails
                }
            }

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
                    totalSymbols: chunks.reduce((sum, chunk) => sum + (chunk.symbols?.length || 0), 0),
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
                    namespace: this.services?.namespaceManagerService?.generateNamespace(request.codebasePath) || 'unknown',
                    totalFiles: 0,
                    totalChunks: 0,
                    totalSymbols: 0,
                    indexingTime: Date.now() - startTime,
                    indexingMethod: 'full' as const,
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

            // Extract symbols and imports at file level for efficiency
            const fileSymbolResult = await this.symbolExtractor.extractSymbols(
                content,
                language.language,
                filePath
            );

            this.logger.debug(`🔍 Symbol extraction for ${filePath}: ${fileSymbolResult.symbols.length} symbols, ${fileSymbolResult.imports.length} imports`);

            // Convert SemanticChunk[] to CodeChunk[] format with enhanced symbols/imports
            const chunks: CodeChunk[] = chunkingResult.chunks.map(semanticChunk => {
                // Find symbols that belong to this chunk (based on line ranges)
                const candidateSymbols = fileSymbolResult.symbols
                    .filter(symbol =>
                        // More flexible filtering: symbol overlaps with chunk
                        symbol.startLine <= semanticChunk.endLine &&
                        symbol.endLine >= semanticChunk.startLine
                    );

                this.logger.debug(`📍 Chunk ${semanticChunk.startLine}-${semanticChunk.endLine}: ${candidateSymbols.length} candidate symbols`);

                const chunkSymbols = candidateSymbols
                    .filter(symbol =>
                        // Filter out symbol types not supported by SymbolInfo interface
                        ['function', 'class', 'interface', 'variable', 'constant', 'type', 'namespace'].includes(symbol.type)
                    )
                    .map(symbol => ({
                        name: symbol.name,
                        type: symbol.type as 'function' | 'class' | 'interface' | 'variable' | 'constant' | 'type' | 'namespace',
                        startLine: symbol.startLine,
                        endLine: symbol.endLine,
                        scope: symbol.scope
                    }));

                this.logger.debug(`✅ Chunk symbols after filtering: ${chunkSymbols.length} symbols - ${chunkSymbols.map(s => s.name).join(', ')}`);

                // Find imports that are relevant to this chunk
                const chunkImports = fileSymbolResult.imports
                    .filter(imp => imp.line <= semanticChunk.endLine) // Imports typically at top of file
                    .map(imp => ({
                        module: imp.module,
                        symbols: imp.symbols,
                        line: imp.line
                    }));


                return {
                    id: semanticChunk.id,
                    content: semanticChunk.content,
                    filePath: semanticChunk.filePath,
                    relativePath: semanticChunk.relativePath,
                    startLine: semanticChunk.startLine,
                    endLine: semanticChunk.endLine,
                    language: semanticChunk.language,
                    symbols: chunkSymbols,
                    imports: chunkImports,
                    exports: fileSymbolResult.exports.filter(exp =>
                        // Associate exports with chunks that contain them
                        chunkSymbols.some(sym => sym.name === exp)
                    )
                };
            });

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










    private async applyContentFiltering(files: string[], codebasePath: string): Promise<string[]> {
        this.logger.info(`🔍 Content filtering ${files.length} files...`);

        const batchSize = 50;
        const filtered: string[] = [];

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);

            const results = await Promise.allSettled(
                batch.map(async (file) => {
                    try {
                        const relativePath = path.relative(codebasePath, file);

                        // Check file size first to avoid reading large files into memory
                        const stats = await fs.stat(file);
                        if (stats.size > 500000) { // 500KB limit (same as ContentFilterProvider)
                            return {
                                file,
                                shouldInclude: {
                                    include: false,
                                    reason: 'File too large (likely data file)',
                                    confidence: 0.9
                                },
                                relativePath
                            };
                        }

                        // Only read content for files under size limit
                        const content = await fs.readFile(file, 'utf-8');
                        const shouldInclude = this.contentFilter.shouldInclude(relativePath, content);
                        return { file, shouldInclude, relativePath };
                    } catch (error) {
                        console.warn(`[INDEXING] ⚠️ Error filtering ${file}: ${error}`);
                        return null;
                    }
                })
            );

            results.forEach((result) => {
                if (result.status === 'fulfilled' && result.value?.shouldInclude.include) {
                    filtered.push(result.value.file);
                } else if (result.status === 'fulfilled' && result.value) {
                    this.logger.debug(`🚫 Filtered: ${result.value.relativePath} (${result.value.shouldInclude.reason})`);
                }
            });
        }

        this.logger.info(`✅ Content filtering complete: ${filtered.length}/${files.length} files included`);
        return filtered;
    }




    /**
     * Upload chunks to vector store with embedding generation
     */
    private async uploadChunksToVectorStore(namespace: string, chunks: CodeChunk[]): Promise<void> {
        if (!chunks.length || !this.services?.jinaApiService || !this.services?.turbopufferService) {
            this.logger.warn(`⚠️ Vector store upload skipped: chunks=${chunks.length}, jinaApiService=${!!this.services?.jinaApiService}, turbopufferService=${!!this.services?.turbopufferService}`);
            return;
        }

        this.logger.info(`Uploading ${chunks.length} chunks to vector store and local metadata...`);
        
        const batchSize = 50; // Optimized batch size for faster processing
        let successfulBatches = 0;
        let skippedBatches = 0;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(chunks.length / batchSize);

            try {
                this.logger.info(`📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} chunks)`);
                
                // Generate embeddings for batch
                this.logger.debug(`🧠 Generating embeddings for ${batch.length} chunks...`);
                const embeddings = await this.services.jinaApiService.generateEmbeddingBatch(
                    batch.map(chunk => chunk.content)
                );
                this.logger.debug(`✅ Generated ${embeddings.length} embeddings`);

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
                    symbols: (chunk.symbols || []).map(s => typeof s === 'string' ? s : s.name).join(',')
                }));

                // Upload to Turbopuffer
                this.logger.debug(`⬆️  Upserting ${upsertData.length} vectors to namespace: ${namespace}`);
                await this.services.turbopufferService.upsert(namespace, upsertData);
                this.logger.info(`✅ Batch ${batchNumber}/${totalBatches} completed successfully`);
                successfulBatches++;
                
                // Add conservative delay between batches to avoid rate limiting
                if (batchNumber < totalBatches) {
                    const processingConfig = this.configurationService.getProcessingConfig();
                    const delay = processingConfig.batchDelayMs;
                    this.logger.debug(`⏱️  Waiting ${delay}ms before next batch...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                // After 3 exponential retries in wildcardFetch, skip this batch and continue
                skippedBatches++;
                this.logger.warn(`⚠️ Skipping batch ${batchNumber} after retries failed. Continuing with remaining batches.`);
                this.logger.warn(`Skipped batch error:`, error instanceof Error ? error.message : String(error));
                
                // Don't throw - just continue to next batch
                // The batch will be lost but indexing continues
                continue;
            }
        }
        
        const totalBatches = Math.ceil(chunks.length / batchSize);
        const successfulChunks = successfulBatches * batchSize;
        const skippedChunks = Math.min(skippedBatches * batchSize, chunks.length - successfulChunks);
        
        if (skippedBatches > 0) {
            this.logger.info(`✅ Upload complete: ${successfulChunks}/${chunks.length} chunks uploaded to namespace: ${namespace} (${skippedBatches}/${totalBatches} batches skipped due to rate limiting)`);
        } else {
            this.logger.info(`✅ Uploaded ${chunks.length} chunks to namespace: ${namespace}`);
        }
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
}
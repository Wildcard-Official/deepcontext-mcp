/**
 * Archived Standalone MCP Methods
 * These methods were removed from the main standalone integration when functionality
 * was moved into appropriate service layers:
 * - Incremental update functionality moved into SearchCoordinationService
 * - Complete indexing functionality moved into IndexingOrchestrator
 */

// Archived: incrementalUpdateCodebase method
async incrementalUpdateCodebase(codebasePath: string, maxAgeHours: number = 24): Promise<{
    success: boolean;
    namespace: string;
    filesProcessed: number;
    chunksCreated: number;
    chunksDeleted: number;
    message: string;
}> {
    const startTime = Date.now();
    const normalizedPath = path.resolve(codebasePath);
    
    const operationKey = `incremental:${normalizedPath}`;
    const lock = await this.acquireLock(operationKey);
    if (!lock.acquired) {
        return {
            success: false,
            namespace: '',
            filesProcessed: 0,
            chunksCreated: 0,
            chunksDeleted: 0,
            message: lock.message
        };
    }

    try {
        // Check if the codebase is indexed
        const indexed = this.indexedCodebases.get(normalizedPath);
        if (!indexed) {
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                chunksDeleted: 0,
                message: `Codebase not indexed: ${codebasePath}. Please run index_codebase first.`
            };
        }

        const namespace = indexed.namespace;
        const lastIndexedTime = await this.getLastIndexedTime(normalizedPath);
        const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
        const referenceTime = lastIndexedTime || cutoffTime;

        return await this.performIncrementalUpdate(normalizedPath, maxAgeHours, startTime);
        
    } catch (error) {
        this.logger.error('Incremental update failed', { 
            error: error instanceof Error ? error.message : String(error),
            codebasePath,
            name: error instanceof Error ? error.name : undefined
        });
        return {
            success: false,
            namespace: '',
            filesProcessed: 0,
            chunksCreated: 0,
            chunksDeleted: 0,
            message: `Incremental update failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
    } finally {
        await this.releaseLock(operationKey);
    }
}

// Archived: performIncrementalUpdate method  
private async performIncrementalUpdate(codebasePath: string, maxAgeHours: number, startTime: number): Promise<{
    success: boolean;
    namespace: string;
    filesProcessed: number;
    chunksCreated: number;
    chunksDeleted: number;
    message: string;
}> {
    const indexed = this.indexedCodebases.get(codebasePath);
    if (!indexed) {
        return {
            success: false,
            namespace: '',
            filesProcessed: 0,
            chunksCreated: 0,
            chunksDeleted: 0,
            message: 'Codebase not indexed'
        };
    }

    this.logger.info(`🔄 Starting incremental update for: ${codebasePath}`);
    
    const lastIndexedTime = await this.getLastIndexedTime(codebasePath);
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
    const referenceTime = lastIndexedTime || cutoffTime;
    
    this.logger.info(`📝 Processing files modified since: ${referenceTime.toISOString()}`);

    // Use FileProcessingService for incremental processing
    const incrementalResult = await this.fileProcessingService.processIncrementalUpdate(
        codebasePath,
        indexed.namespace,
        referenceTime
    );

    const totalChunksDeleted = incrementalResult.chunksDeleted;
    const totalChunksCreated = incrementalResult.chunksCreated;
    const filesProcessed = incrementalResult.filesProcessed;

    // Save the timestamp for this incremental update
    await this.saveLastIndexedTime(codebasePath, new Date());
    
    const message = `✅ Incremental update complete: ${filesProcessed} files processed (${totalChunksDeleted} deleted, ${totalChunksCreated} created chunks) in ${Date.now() - startTime}ms`;
    this.logger.info(message);

    return {
        success: true,
        namespace: indexed.namespace,
        filesProcessed,
        chunksCreated: totalChunksCreated,
        chunksDeleted: totalChunksDeleted,
        message
    };
}

// Archived: Incremental update callback creation logic from constructor
const incrementalUpdateCallback = async (codebasePath: string, maxAgeHours: number = 24) => {
    const result = await this.incrementalUpdateCodebase(codebasePath, maxAgeHours);
    return {
        success: result.success,
        filesProcessed: result.filesProcessed,
        message: result.message
    };
};

// ================================
// ARCHIVED TIMESTAMP DELEGATION METHODS
// ================================

// Archived: getLastIndexedTime method - delegated to FileProcessingService
async getLastIndexedTime(codebasePath: string): Promise<Date | null> {
    return await this.fileProcessingService.getLastIndexedTime(codebasePath);
}

// Archived: saveLastIndexedTime method - delegated to FileProcessingService
async saveLastIndexedTime(codebasePath: string, timestamp: Date): Promise<void> {
    await this.fileProcessingService.saveLastIndexedTime(codebasePath, timestamp);
}

// ================================
// ARCHIVED CODEBASE REGISTRY METHODS - DELEGATED TO NamespaceManagerService
// ================================

// Archived: getIndexedCodebasesPath method - delegated to NamespaceManagerService
private getIndexedCodebasesPath(): string {
    const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
    return path.join(dataDir, 'indexed-codebases.json');
}

// Archived: saveIndexedCodebases method - delegated to NamespaceManagerService
private async saveIndexedCodebases(): Promise<void> {
    try {
        const dataPath = this.getIndexedCodebasesPath();
        const dir = path.dirname(dataPath);

        await fs.mkdir(dir, { recursive: true });

        const data = Array.from(this.indexedCodebases.entries());
        await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
        this.logger.warn('Failed to save indexed codebases:', error);
    }
}

// Archived: loadIndexedCodebases method - delegated to NamespaceManagerService
private async loadIndexedCodebases(): Promise<void> {
    try {
        const dataPath = this.getIndexedCodebasesPath();
        const content = await fs.readFile(dataPath, 'utf-8');
        const data = JSON.parse(content);

        this.indexedCodebases = new Map(data);
    } catch (error) {
        // No existing data, start fresh
        this.indexedCodebases = new Map();
    }
}

// Archived: initialize method - now delegates to NamespaceManagerService.initialize()
async initialize(): Promise<void> {
    await this.loadIndexedCodebases();
    await this.symbolExtractor.initialize();
    this.logger.info(`Loaded ${this.indexedCodebases.size} indexed codebases`);
}

// ================================
// ARCHIVED INDEXING METHODS
// ================================

// Archived: indexCodebaseIntelligent method
async indexCodebaseIntelligent(codebasePath: string, forceReindex = false): Promise<{
    success: boolean;
    namespace: string;
    filesProcessed: number;
    chunksCreated: number;
    processingTimeMs: number;
    message: string;
}> {
    const normalizedPath = path.resolve(codebasePath);
    const operationKey = `full:${normalizedPath}`;
    
    // Check for concurrent operations using file-based locking
    const lockFileResult = await this.acquireLock(operationKey);
    if (!lockFileResult.acquired) {
        return {
            success: false,
            namespace: '',
            filesProcessed: 0,
            chunksCreated: 0,
            processingTimeMs: 0,
            message: lockFileResult.message
        };
    }

    const startTime = Date.now();
    
    // Create operation promise for concurrency tracking
    const operationPromise = this.performFullIndexing(normalizedPath, forceReindex, startTime);
    this.activeOperations.set(operationKey, operationPromise);
    
    try {
        return await operationPromise;
    } finally {
        this.activeOperations.delete(operationKey);
        await this.releaseLock(operationKey);
    }
}

// Archived: performFullIndexing method
private async performFullIndexing(codebasePath: string, forceReindex: boolean, startTime: number): Promise<{
    success: boolean;
    namespace: string;
    filesProcessed: number;
    chunksCreated: number;
    processingTimeMs: number;
    message: string;
}> {
    
    try {
        // Validate path exists and is accessible
        const normalizedPath = path.resolve(codebasePath);
        await fs.access(normalizedPath);
        
        this.logger.info(`Starting intelligent indexing for: ${codebasePath}`);
        
        // Use new architecture for indexing
        const indexingRequest: IndexingRequest = {
            codebasePath,
            force: forceReindex,
            enableContentFiltering: true,
            enableDependencyAnalysis: true
        };

        const result = await this.indexingOrchestrator.indexCodebase(indexingRequest);
        
        if (!result.success) {
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                processingTimeMs: Date.now() - startTime,
                message: `Indexing failed with ${result.errors.length} errors`
            };
        }
        
        // Upload to vector store using real API (pass CoreChunk directly)
        await this.uploadChunksToVectorStore(result.metadata.namespace, result.chunks);
        
        // Store indexing metadata only if chunks were actually uploaded
        if (result.chunks.length > 0) {
            const resolvedPath = path.resolve(codebasePath);
            const indexedCodebase: IndexedCodebase = {
                path: resolvedPath,
                namespace: result.metadata.namespace,
                totalChunks: result.chunks.length,
                indexedAt: new Date().toISOString()
            };
            
            this.indexedCodebases.set(resolvedPath, indexedCodebase);
            await this.saveIndexedCodebases();
        }

        // Also save timestamp for incremental indexing
        await this.saveLastIndexedTime(codebasePath, new Date());

        const processingTime = Date.now() - startTime;
        
        this.logger.info(`✅ Indexing completed: ${result.metadata.totalFiles} files, ${result.chunks.length} chunks`);
        
        return {
            success: true,
            namespace: result.metadata.namespace,
            filesProcessed: result.metadata.totalFiles,
            chunksCreated: result.chunks.length,
            processingTimeMs: processingTime,
            message: `Successfully indexed ${result.metadata.totalFiles} files into ${result.chunks.length} intelligent chunks`
        };
        
    } catch (error) {
        this.logger.error('Indexing failed:', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined
        });
        return {
            success: false,
            namespace: '',
            filesProcessed: 0,
            chunksCreated: 0,
            processingTimeMs: Date.now() - startTime,
            message: `Indexing failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

// Archived: uploadChunksToVectorStore method
private async uploadChunksToVectorStore(namespace: string, chunks: CoreChunk[]): Promise<void> {
    if (!chunks.length) return;
    
    this.logger.info(`Uploading ${chunks.length} chunks to vector store and local metadata...`);
    
    const batchSize = 50;
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        // Generate embeddings for batch
        const embeddings = await this.jinaApiService.generateEmbeddingBatch(
            batch.map(chunk => chunk.content)
        );
        
        // Prepare upsert data in Turbopuffer v2 format with schema for full-text search
        const upsertData = batch.map((chunk, index) => ({
            id: chunk.id,
            vector: embeddings[index],
            attributes: {
                content: chunk.content,
                symbols: chunk.symbols.map(s => s.name).join(','),
                filePath: chunk.filePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: chunk.language
            }
        }));
        
        await this.turbopufferService.upsert(namespace, upsertData);
    }
    
    this.logger.info(`✅ Uploaded ${chunks.length} chunks to namespace: ${namespace}`);
}

// ================================
// ARCHIVED SEARCH METHODS
// ================================

// Archived: Old hybrid search implementation with direct Turbopuffer calls
// OLD IMPLEMENTATION BELOW - removed from main integration
// Use direct Turbopuffer hybrid search with queries array approach
/*
this.logger.debug('Generating embedding for hybrid search...');
const embedding = await this.jinaApiService.generateEmbedding(query);
this.logger.info(`Embedding generated: ${embedding.length} dimensions`);

this.logger.info('Calling Turbopuffer hybrid search...');
const rawResults = await this.turbopufferService.hybridSearch(namespace, {
    embedding,
    query,
    limit: options.limit || 10,
    vectorWeight: options.vectorWeight || 0.1,
    bm25Weight: options.bm25Weight || 0.9
});

this.logger.info(`Raw results received: ${rawResults.length}`);

// Convert results to expected format with smart boundary extension
const results = await Promise.all(rawResults.map(async (result: any) => {
    let content = result.metadata.content;
    let endLine = result.metadata.endLine;
    
    // Content is already properly chunked by IndexingOrchestrator with complete semantic boundaries
    
    // Add connection context for better architecture understanding
    const connections = await this.extractConnectionContext(
        result.metadata.filePath,
        content
    );
    
    return {
        id: result.id,
        score: result.score,
        content: content,
        filePath: result.metadata.filePath,
        startLine: result.metadata.startLine,
        endLine: endLine,
        symbols: result.metadata.symbols ? result.metadata.symbols.split(',').filter(Boolean) : [],
        language: result.metadata.language,
        similarity: result.score,
        connections: connections
    };
}));

const searchTime = Date.now() - startTime;

this.logger.info(`✅ Hybrid search completed: ${results.length} results in ${searchTime}ms`);

return {
    success: true,
    results,
    searchTime,
    strategy: 'hybrid',
    metadata: {
        vectorResults: Math.floor(results.length * (options.vectorWeight || 0.7)),
        bm25Results: Math.floor(results.length * (options.bm25Weight || 0.3)),
        totalMatches: results.length,
        queryEnhanced: options.enableQueryEnhancement !== false,
        reranked: options.enableReranking !== false
    }
};
*/

// Archived: createEmbeddingIntegration method 
private createEmbeddingIntegration(): any {
    return {
        embed: async (text: string) => {
            return await this.jinaApiService.generateEmbedding(text);
        },
        embedBatch: async (texts: string[]) => {
            return await this.jinaApiService.generateEmbeddingBatch(texts);
        }
    };
}

// Archived: Full searchHybrid method with old implementation
async searchHybrid(codebasePath: string, query: string, options: {
    limit?: number;
    vectorWeight?: number;
    bm25Weight?: number;
    fileTypes?: string[];
    enableQueryEnhancement?: boolean;
    enableReranking?: boolean;
} = {}): Promise<{
    success: boolean;
    results: any[];
    searchTime: number;
    strategy: string;
    metadata: {
        vectorResults: number;
        bm25Results: number;
        totalMatches: number;
        queryEnhanced: boolean;
        reranked: boolean;
    };
}> {
    const startTime = Date.now();
    
    if (!query || query.trim().length === 0) {
        return {
            success: false,
            results: [],
            searchTime: Date.now() - startTime,
            strategy: 'hybrid',
            metadata: {
                vectorResults: 0,
                bm25Results: 0,
                totalMatches: 0,
                queryEnhanced: false,
                reranked: false
            }
        };
    }
    
    const namespace = this.namespaceManagerService.generateNamespace(codebasePath);
    
    try {
        this.logger.info(`🔍 Hybrid search: "${query}" in ${codebasePath}`);

        // Use SearchCoordinationService for hybrid search
        const searchResult = await this.searchCoordinationService.searchHybrid(namespace, query, {
            limit: options.limit || 10,
            vectorWeight: options.vectorWeight || 0.1,
            bm25Weight: options.bm25Weight || 0.9
        });

        // Adapt the result format to match our expected interface
        return {
            success: searchResult.success,
            results: searchResult.results,
            searchTime: searchResult.searchTime,
            strategy: searchResult.strategy,
            metadata: {
                vectorResults: searchResult.metadata?.vectorResults || 0,
                bm25Results: searchResult.metadata?.bm25Results || 0,
                totalMatches: searchResult.metadata?.totalMatches || searchResult.results.length,
                queryEnhanced: searchResult.metadata?.queryEnhanced || (options.enableQueryEnhancement !== false),
                reranked: searchResult.metadata?.reranked || (options.enableReranking !== false)
            }
        };

    } catch (error) {
        this.logger.error('Hybrid search failed', { 
            error: error instanceof Error ? error.message : String(error), 
            stack: error instanceof Error ? error.stack : undefined,
            query: query.substring(0, 50) 
        });
        return {
            success: false,
            results: [],
            searchTime: Date.now() - startTime,
            strategy: 'hybrid',
            metadata: {
                vectorResults: 0,
                bm25Results: 0,
                totalMatches: 0,
                queryEnhanced: false,
                reranked: false
            }
        };
    }
}

// Archived: searchBM25 method
async searchBM25(codebasePath: string, query: string, options: {
    limit?: number;
    fileTypes?: string[];
    offset?: number;
    enableReranking?: boolean;
} = {}): Promise<{
    success: boolean;
    results: any[];
    searchTime: number;
    strategy: string;
}> {
    try {
        const namespace = this.namespaceManagerService.generateNamespace(codebasePath);
        
        // Use SearchCoordinationService for BM25 search
        const searchResult = await this.searchCoordinationService.searchBM25(namespace, query, {
            limit: options.limit || 10,
            enableReranking: options.enableReranking !== false
        });
        
        return {
            success: searchResult.success,
            results: searchResult.results,
            searchTime: searchResult.searchTime,
            strategy: searchResult.strategy
        };

    } catch (error) {
        const startTime = Date.now();
        this.logger.error('BM25 search failed', { error, query: query.substring(0, 50) });
        return {
            success: false,
            results: [],
            searchTime: Date.now() - startTime,
            strategy: 'bm25'
        };
    }
}

// Archived: searchWithIntelligence method
async searchWithIntelligence(query: string, codebasePath?: string, maxResults = 10): Promise<{
    success: boolean;
    results: CodeChunk[];
    totalResults: number;
    searchTimeMs: number;
    message: string;
}> {
    try {
        // Use SearchCoordinationService for intelligent search
        const searchResult = await this.searchCoordinationService.searchWithIntelligence(
            query, 
            codebasePath, 
            this.indexedCodebases,
            maxResults
        );
        
        // Convert results to standalone format if successful
        if (searchResult.success && searchResult.results.length > 0) {
            const results: CodeChunk[] = searchResult.results.map((result: any) => ({
                id: result.id,
                content: result.content,
                filePath: result.filePath,
                relativePath: result.metadata?.relativePath || path.relative(codebasePath || '', result.filePath),
                startLine: result.startLine,
                endLine: result.endLine,
                language: result.language || 'unknown',
                symbols: result.symbols || [],
                score: result.score,
                connections: result.connections // Preserve connection context
            }));

            return {
                success: true,
                results,
                totalResults: results.length,
                searchTimeMs: searchResult.searchTimeMs,
                message: searchResult.message
            };
        }
        
        return {
            success: searchResult.success,
            results: [],
            totalResults: 0,
            searchTimeMs: searchResult.searchTimeMs,
            message: searchResult.message
        };
        
    } catch (error) {
        const startTime = Date.now();
        this.logger.error('Search failed:', error);
        return {
            success: false,
            results: [],
            totalResults: 0,
            searchTimeMs: Date.now() - startTime,
            message: `Search failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

// ================================
// ARCHIVED INDEXING STATUS METHODS
// ================================

// Archived: getIndexingStatus method - moved to IndexingOrchestrator
async getIndexingStatus(codebasePath?: string): Promise<{
    indexedCodebases: IndexedCodebase[];
    currentCodebase?: IndexedCodebase;
    incrementalStats?: any;
    // Convenience properties for simple status checks
    indexed: boolean;
    fileCount: number;
}> {
    const indexedList = Array.from(this.indexedCodebases.values());
    
    let currentCodebase: IndexedCodebase | undefined;
    let incrementalStats: any;
    
    if (codebasePath) {
        // Validate path exists if provided
        try {
            const normalizedPath = path.resolve(codebasePath);
            await fs.access(normalizedPath);
            currentCodebase = this.indexedCodebases.get(normalizedPath);
        } catch (error) {
            // Path doesn't exist - return empty status
            return {
                indexedCodebases: indexedList,
                indexed: false,
                fileCount: 0
            };
        }
        
        if (currentCodebase) {
            // Note: Incremental stats could be implemented here if needed
            incrementalStats = {
                indexingMethod: 'full',
                lastIndexed: currentCodebase.indexedAt
            };
        }
    }

    // Calculate convenience properties
    const indexed = codebasePath ? !!currentCodebase : indexedList.length > 0;
    const fileCount = currentCodebase?.totalChunks || indexedList.reduce((sum, cb) => sum + cb.totalChunks, 0);

    return {
        indexedCodebases: indexedList,
        currentCodebase,
        incrementalStats,
        indexed,
        fileCount
    };
}

// Archived: clearIndex method - moved to IndexingOrchestrator
async clearIndex(codebasePath?: string): Promise<{
    success: boolean;
    message: string;
    clearedNamespaces: string[];
}> {
    try {
        const namespacesToClear: string[] = [];
        
        if (codebasePath) {
            const indexed = this.indexedCodebases.get(codebasePath);
            if (indexed) {
                namespacesToClear.push(indexed.namespace);
                this.indexedCodebases.delete(codebasePath);
                
                // Note: Could clear incremental metadata here if implemented
            }
        } else {
            // Clear all
            for (const indexed of this.indexedCodebases.values()) {
                namespacesToClear.push(indexed.namespace);
            }
            this.indexedCodebases.clear();
        }

        // Clear from vector store
        for (const namespace of namespacesToClear) {
            await this.turbopufferService.clearNamespace(namespace);
        }

        await this.saveIndexedCodebases();
        
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

// ================================
// ARCHIVED CONNECTION CONTEXT METHODS
// ================================

// Archived connection context extraction methods - replaced by TreeSitterSymbolExtractorFull
// These methods were removed from StandaloneCodexMcp on 2025-01-14 and replaced with
// TreeSitterSymbolExtractorFull for better accuracy and consistency.

// Archived: Original extractConnectionContext method - redundant with TreeSitter chunking
private async extractConnectionContext(
    filePath: string,
    chunkContent: string
): Promise<{ imports: string[]; exports: string[]; relatedFiles: string[] }> {
    try {
        // Only add connections for chunks that define classes, interfaces, or exports
        const definesArchitecture = this.definesArchitecture(chunkContent);
        if (!definesArchitecture) {
            return { imports: [], exports: [], relatedFiles: [] };
        }

        // Read the full file to extract imports/exports
        const fullContent = await fs.readFile(filePath, 'utf-8');
        const lines = fullContent.split('\n');

        // Extract relevant imports (only search/architecture related)
        const relevantImports = lines
            .filter(line => line.trim().startsWith('import '))
            .map(line => line.trim())
            .filter(importLine => this.isRelevantImport(importLine));

        // Extract exports from the chunk itself
        const exports = this.extractExports(chunkContent);

        // Extract related file paths from imports
        const relatedFiles = relevantImports
            .map(imp => this.extractFilePath(imp))
            .filter((path): path is string => path !== null);

        return {
            imports: relevantImports.slice(0, 5), // Limit to 5 most relevant
            exports: exports,
            relatedFiles: relatedFiles
        };

    } catch (error) {
        this.logger.debug('Failed to extract connection context:', error);
        return { imports: [], exports: [], relatedFiles: [] };
    }
}

// Archived: definesArchitecture helper
private definesArchitecture(content: string): boolean {
    // High-confidence architectural indicators
    if (/export\s+(class|interface|type|enum)/.test(content)) return true;
    if (/^(export\s+)?class\s+\w+/m.test(content)) return true;
    if (/^(export\s+)?interface\s+\w+/m.test(content)) return true;
    if (/^(export\s+)?type\s+\w+\s*=/m.test(content)) return true;
    
    // Exported functions that are likely API endpoints or services
    const exportedFunction = /export\s+(async\s+)?function\s+\w+/.test(content);
    const servicePattern = /(Service|Provider|Engine|Store|Manager|Controller|Handler)/.test(content);
    if (exportedFunction && servicePattern) return true;
    
    // Constructor or main service functions
    const isConstructor = /constructor\s*\(/.test(content);
    const isServiceMethod = /\b(initialize|setup|create|build|configure)\b/.test(content) && servicePattern;
    if (isConstructor || isServiceMethod) return true;
    
    // Avoid marking simple utility functions or implementation details
    const isSimpleFunction = content.split('\n').length < 10 && 
                            /^[^{]*\{[^}]*\}[^}]*$/s.test(content.trim());
    const isUtilFunction = /\b(get|set|is|has|should|can|will)\w*\s*\(/.test(content);
    if (isSimpleFunction || isUtilFunction) return false;
    
    return false;
}

// Archived: isRelevantImport helper
private isRelevantImport(importLine: string): boolean {
    // Skip common utility imports that aren't architecturally significant
    const skipPatterns = [
        /import.*from\s+['"`]fs['"`]/,
        /import.*from\s+['"`]path['"`]/,
        /import.*from\s+['"`]util['"`]/,
        /import.*from\s+['"`]crypto['"`]/,
        /import.*\{[^}]*\}\s+from\s+['"`][./]*utils/,
    ];
    
    if (skipPatterns.some(pattern => pattern.test(importLine))) {
        return false;
    }
    
    // High-relevance architectural imports
    const highRelevanceKeywords = [
        'HybridSearch', 'SearchService', 'EmbeddingProvider', 'VectorStore',
        'TurbopufferStore', 'JinaEmbedding', 'IndexingOrchestrator',
        'SearchResult', 'CodeChunk', 'SearchOptions'
    ];
    
    // Medium-relevance keywords (must be in class/interface context)
    const mediumRelevanceKeywords = [
        'Service', 'Provider', 'Engine', 'Store', 'Manager', 'Controller'
    ];
    
    // Only include if high relevance OR medium relevance with proper context
    const hasHighRelevance = highRelevanceKeywords.some(keyword => importLine.includes(keyword));
    const hasMediumRelevance = mediumRelevanceKeywords.some(keyword => importLine.includes(keyword)) &&
                             /import\s*\{[^}]*[A-Z]\w*(Service|Provider|Engine|Store|Manager|Controller)/.test(importLine);
    
    return hasHighRelevance || hasMediumRelevance;
}

// Archived: extractExports helper
private extractExports(content: string): string[] {
    const exportMatches = content.match(/export\s+(class|interface|type|function|const|enum)\s+(\w+)/g);
    return exportMatches ? exportMatches.slice(0, 3) : []; // Limit to 3 exports
}

// Archived: extractFilePath helper
private extractFilePath(importLine: string): string | null {
    const match = importLine.match(/from\s+['"]([^'"]+)['"]/);
    return match ? match[1] : null;
}

// ================================
// NEWLY ARCHIVED FROM 2025-01-14 REFACTOR
// ================================

// The following methods were removed from StandaloneCodexMcp and replaced
// with TreeSitterSymbolExtractorFull for better import/export extraction:

// Archived: Original extractConnectionContext method using regex-based parsing
/*
private async extractConnectionContext(
    filePath: string,
    chunkContent: string
): Promise<{ imports: string[]; exports: string[]; relatedFiles: string[] }> {
    try {
        // Only add connections for chunks that define classes, interfaces, or exports
        const definesArchitecture = this.definesArchitecture(chunkContent);
        if (!definesArchitecture) {
            return { imports: [], exports: [], relatedFiles: [] };
        }

        // Read the full file to extract imports/exports
        const fullContent = await fs.readFile(filePath, 'utf-8');
        const lines = fullContent.split('\n');

        // Extract relevant imports (only search/architecture related)
        const relevantImports = lines
            .filter(line => line.trim().startsWith('import '))
            .map(line => line.trim())
            .filter(importLine => this.isRelevantImport(importLine));

        // Extract exports from the chunk itself
        const exports = this.extractExports(chunkContent);

        // Extract related file paths from imports
        const relatedFiles = relevantImports
            .map(imp => this.extractFilePath(imp))
            .filter((path): path is string => path !== null);

        return {
            imports: relevantImports.slice(0, 5), // Limit to 5 most relevant
            exports: exports,
            relatedFiles: relatedFiles
        };

    } catch (error) {
        this.logger.debug('Failed to extract connection context:', error);
        return { imports: [], exports: [], relatedFiles: [] };
    }
}
*/

// Archived: definesArchitecture method - replaced by AST-based detection
/*
private definesArchitecture(content: string): boolean {
    // High-confidence architectural indicators
    if (/export\s+(class|interface|type|enum)/.test(content)) return true;
    if (/^(export\s+)?class\s+\w+/m.test(content)) return true;
    if (/^(export\s+)?interface\s+\w+/m.test(content)) return true;
    if (/^(export\s+)?type\s+\w+\s*=/m.test(content)) return true;

    // Exported functions that are likely API endpoints or services
    const exportedFunction = /export\s+(async\s+)?function\s+\w+/.test(content);
    const servicePattern = /(Service|Provider|Engine|Store|Manager|Controller|Handler)/.test(content);
    if (exportedFunction && servicePattern) return true;

    // Constructor or main service functions
    const isConstructor = /constructor\s*\(/.test(content);
    const isServiceMethod = /\b(initialize|setup|create|build|configure)\b/.test(content) && servicePattern;
    if (isConstructor || isServiceMethod) return true;

    // Avoid marking simple utility functions or implementation details
    const isSimpleFunction = content.split('\n').length < 10 &&
                            /^[^{]*\{[^}]*\}[^}]*$/s.test(content.trim());
    const isUtilFunction = /\b(get|set|is|has|should|can|will)\w*\s*\(/.test(content);
    if (isSimpleFunction || isUtilFunction) return false;

    return false;
}
*/

// Archived: isRelevantImport method - replaced by AST-based analysis
/*
private isRelevantImport(importLine: string): boolean {
    // Skip common utility imports that aren't architecturally significant
    const skipPatterns = [
        /import.*from\s+['"`]fs['"`]/,
        /import.*from\s+['"`]path['"`]/,
        /import.*from\s+['"`]util['"`]/,
        /import.*from\s+['"`]crypto['"`]/,
        /import.*\{[^}]*\}\s+from\s+['"`][./]*utils/,
    ];

    if (skipPatterns.some(pattern => pattern.test(importLine))) {
        return false;
    }

    // High-relevance architectural imports
    const highRelevanceKeywords = [
        'HybridSearch', 'SearchService', 'EmbeddingProvider', 'VectorStore',
        'TurbopufferStore', 'JinaEmbedding', 'IndexingOrchestrator',
        'SearchResult', 'CodeChunk', 'SearchOptions'
    ];

    // Medium-relevance keywords (must be in class/interface context)
    const mediumRelevanceKeywords = [
        'Service', 'Provider', 'Engine', 'Store', 'Manager', 'Controller'
    ];

    // Only include if high relevance OR medium relevance with proper context
    const hasHighRelevance = highRelevanceKeywords.some(keyword => importLine.includes(keyword));
    const hasMediumRelevance = mediumRelevanceKeywords.some(keyword => importLine.includes(keyword)) &&
                             /import\s*\{[^}]*[A-Z]\w*(Service|Provider|Engine|Store|Manager|Controller)/.test(importLine);

    return hasHighRelevance || hasMediumRelevance;
}
*/

// Archived: extractExports method - replaced by AST-based extraction
/*
private extractExports(content: string): string[] {
    const exportMatches = content.match(/export\s+(class|interface|type|function|const|enum)\s+(\w+)/g);
    return exportMatches ? exportMatches.slice(0, 3) : []; // Limit to 3 exports
}
*/

// Archived: extractFilePath method - replaced by AST-based path resolution
/*
private extractFilePath(importLine: string): string | null {
    const match = importLine.match(/from\s+['"]([^'"]+)['"]/);
    return match ? match[1] : null;
}
*/

// ================================
// NEWLY ARCHIVED FROM 2025-01-14 LOCK REFACTOR
// ================================

// The following lock methods were removed from StandaloneCodexMcp and replaced
// with the dedicated LockService for better reusability and consistency:

// Archived: File-based concurrency protection methods
/*
// File-based concurrency protection
private getLockFilePath(operationKey: string): string {
    const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
    const safeKey = operationKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    return path.join(dataDir, `${safeKey}.lock`);
}

private async acquireLock(operationKey: string): Promise<{ acquired: boolean; message: string }> {
    const lockFilePath = this.getLockFilePath(operationKey);

    try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

        // Try to create lock file exclusively (fails if exists)
        await fs.writeFile(lockFilePath, JSON.stringify({
            operation: operationKey,
            pid: process.pid,
            startTime: new Date().toISOString()
        }), { flag: 'wx' }); // 'wx' = create exclusive, fail if exists

        return { acquired: true, message: 'Lock acquired successfully' };

    } catch (error: any) {
        if (error.code === 'EEXIST') {
            // Lock file exists - check if it's stale
            try {
                const lockContent = await fs.readFile(lockFilePath, 'utf-8');
                const lockData = JSON.parse(lockContent);
                const lockTime = new Date(lockData.startTime);
                const now = new Date();
                const ageMinutes = (now.getTime() - lockTime.getTime()) / (1000 * 60);

                if (ageMinutes > 30) { // Consider locks older than 30 minutes as stale
                    this.logger.warn(`Removing stale lock file (${ageMinutes.toFixed(1)} minutes old): ${lockFilePath}`);
                    await fs.unlink(lockFilePath);
                    // Try to acquire lock again
                    return await this.acquireLock(operationKey);
                } else {
                    return {
                        acquired: false,
                        message: `Operation already in progress (started ${ageMinutes.toFixed(1)} minutes ago)`
                    };
                }
            } catch (readError) {
                // Corrupt lock file - remove and retry
                try {
                    await fs.unlink(lockFilePath);
                    return await this.acquireLock(operationKey);
                } catch (unlinkError) {
                    return {
                        acquired: false,
                        message: 'Failed to acquire lock due to file system issue'
                    };
                }
            }
        } else {
            return {
                acquired: false,
                message: `Failed to acquire lock: ${error.message}`
            };
        }
    }
}

private async releaseLock(operationKey: string): Promise<void> {
    const lockFilePath = this.getLockFilePath(operationKey);

    try {
        await fs.unlink(lockFilePath);
        this.logger.debug(`Released lock: ${operationKey}`);
    } catch (error: any) {
        // Lock file might not exist or be already deleted - that's OK
        this.logger.debug(`Lock release no-op (file not found): ${operationKey}`);
    }
}
*/

// These methods have been moved to a dedicated LockService for reusability
// across FileProcessingService and StandaloneCodexMcp

// ================================
// NEWLY ARCHIVED FROM 2025-01-14 TIMESTAMP/PERSISTENCE REFACTOR
// ================================

// The following timestamp and persistence methods were removed from StandaloneCodexMcp
// and replaced with delegation to FileProcessingService which already has this functionality:

// Archived: Timestamp management methods - replaced by FileProcessingService
/*
// Indexing helpers
private getLastIndexedTimestampPath(codebasePath: string): string {
    const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
    const namespace = this.namespaceManagerService.generateNamespace(codebasePath);
    return path.join(dataDir, `${namespace}-last-indexed.txt`);
}

private async getLastIndexedTime(codebasePath: string): Promise<Date | null> {
    try {
        const timestampPath = this.getLastIndexedTimestampPath(codebasePath);
        const content = await fs.readFile(timestampPath, 'utf-8');
        return new Date(content.trim());
    } catch (error) {
        // No timestamp file exists yet
        return null;
    }
}

private async saveLastIndexedTime(codebasePath: string, timestamp: Date): Promise<void> {
    try {
        const timestampPath = this.getLastIndexedTimestampPath(codebasePath);
        const dir = path.dirname(timestampPath);

        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(timestampPath, timestamp.toISOString(), 'utf-8');
    } catch (error) {
        this.logger.warn('Failed to save last indexed timestamp:', error);
    }
}
*/

// Archived: Codebase persistence methods - replaced by delegating to FileProcessingService
/*
// Persistence
private getIndexedCodebasesPath(): string {
    const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
    return path.join(dataDir, 'indexed-codebases.json');
}

private async saveIndexedCodebases(): Promise<void> {
    try {
        const dataPath = this.getIndexedCodebasesPath();
        const dir = path.dirname(dataPath);

        await fs.mkdir(dir, { recursive: true });

        const data = Array.from(this.indexedCodebases.entries());
        await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
        this.logger.warn('Failed to save indexed codebases:', error);
    }
}

private async loadIndexedCodebases(): Promise<void> {
    try {
        const dataPath = this.getIndexedCodebasesPath();
        const content = await fs.readFile(dataPath, 'utf-8');
        const data = JSON.parse(content);

        this.indexedCodebases = new Map(data);
    } catch (error) {
        // No existing data, start fresh
        this.indexedCodebases = new Map();
    }
}
*/

// These methods have been replaced by using FileProcessingService methods:
// - getLastIndexedTime() -> this.fileProcessingService.getLastIndexedTime()
// - saveLastIndexedTime() -> this.fileProcessingService.saveLastIndexedTime()
// - Codebase persistence simplified to use existing metadata from incremental processing

// Archived redundant comment sections:
// "Search using new architecture with real API calls"
// "Jina AI integration methods removed - now using jinaApiService directly"
// "Turbopuffer integration"
// "True hybrid search combining vector and BM25 with RRF fusion"
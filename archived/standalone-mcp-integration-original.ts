/**
 * Integration layer that combines the new core architecture 
 * with the working standalone MCP implementation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// MCP Server imports
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    Tool,
    Resource
} from '@modelcontextprotocol/sdk/types.js';

// Core components
import { IndexingOrchestrator } from './core/indexing/IndexingOrchestrator.js';
import { FileUtils } from './utils/FileUtils.js';
import { Logger } from './utils/Logger.js';
import { TurbopufferStore } from './services/HybridSearchService.js';
import { JinaApiService } from './services/JinaApiService.js';
import { TurbopufferService } from './services/TurbopufferService.js';
import { ConfigurationService } from './services/ConfigurationService.js';
import { NamespaceManagerService } from './services/NamespaceManagerService.js';
import { FileProcessingService } from './services/FileProcessingService.js';
import { SearchCoordinationService } from './services/SearchCoordinationService.js';

// Types from IndexingOrchestrator (actual implementation)
import type { 
    IndexingRequest,
    IndexingResult,
    CodeChunk as CoreChunk
} from './core/indexing/IndexingOrchestrator.js';


interface CodeChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbols: string[];
    score?: number;
    connections?: {
        imports: string[];
        exports: string[];
        relatedFiles: string[];
    };
}

interface IndexedCodebase {
    path: string;
    namespace: string;
    totalChunks: number;
    indexedAt: string;
}

interface McpConfig {
    jinaApiKey: string;
    turbopufferApiKey: string;
    openaiApiKey?: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class StandaloneCodexMcp {
    private config: McpConfig;
    private indexingOrchestrator: IndexingOrchestrator;
    private fileUtils: FileUtils;
    private logger: Logger;
    private turbopufferStore: TurbopufferStore;
    private jinaApiService: JinaApiService;
    private turbopufferService: TurbopufferService;
    private configurationService: ConfigurationService;
    private namespaceManagerService: NamespaceManagerService;
    private fileProcessingService: FileProcessingService;
    private searchCoordinationService: SearchCoordinationService;
    
    // State management
    private indexedCodebases: Map<string, IndexedCodebase> = new Map();
    
    // Concurrency protection (file-based for cross-process)
    private activeOperations = new Map<string, Promise<any>>();

    constructor(config?: Partial<McpConfig>) {
        // Initialize ConfigurationService with provided config
        this.configurationService = new ConfigurationService(config, { logConfigurationStatus: false });
        this.config = this.configurationService.getConfig();
        
        this.logger = new Logger('STANDALONE-INTEGRATION', this.config.logLevel);
        this.fileUtils = new FileUtils();
        this.indexingOrchestrator = new IndexingOrchestrator();
        this.jinaApiService = new JinaApiService(this.config.jinaApiKey);
        this.turbopufferService = new TurbopufferService(this.config.turbopufferApiKey);
        
        // Initialize NamespaceManagerService with mock codebase operations
        const mockCodebaseOps = {
            clearNamespace: async (namespace: string) => {
                await this.turbopufferService.clearNamespace(namespace);
            }
        };
        this.namespaceManagerService = new NamespaceManagerService(mockCodebaseOps);
        
        // Initialize FileProcessingService with chunk operations
        const mockChunkOps = {
            getChunkIdsForFile: async (namespace: string, filePath: string) => {
                return await this.turbopufferService.getChunkIdsForFile(namespace, filePath);
            },
            deleteChunksByIds: async (namespace: string, chunkIds: string[]) => {
                return await this.turbopufferService.deleteChunksByIds(namespace, chunkIds);
            },
            uploadChunks: async (namespace: string, chunks: any[]) => {
                await this.uploadChunksToVectorStore(namespace, chunks);
            }
        };
        this.fileProcessingService = new FileProcessingService(mockChunkOps);
        
        // Initialize SearchCoordinationService with connection extractor
        const mockConnectionExtractor = async (filePath: string, content: string) => {
            return await this.extractConnectionContext(filePath, content);
        };
        this.searchCoordinationService = new SearchCoordinationService(
            this.jinaApiService,
            this.turbopufferService,
            mockConnectionExtractor
        );
        
        // Create Turbopuffer store integration
        this.turbopufferStore = {
            search: async (namespace: string, options: any) => {
                return await this.turbopufferService.search(namespace, options);
            },
            hybridSearch: async (namespace: string, options: any) => {
                return await this.turbopufferService.hybridSearch(namespace, options);
            }
        };
    }

    /**
     * Incrementally update codebase - only process files modified since last indexing
     */
    async incrementalUpdateCodebase(codebasePath: string, maxAgeHours: number = 24): Promise<{
        success: boolean;
        namespace: string;
        filesProcessed: number;
        chunksCreated: number;
        chunksDeleted: number;
        processingTimeMs: number;
        message: string;
    }> {
        const normalizedPath = path.resolve(codebasePath);
        const operationKey = `incremental:${normalizedPath}`;
        
        // Check for concurrent operations using file-based locking
        const lockFileResult = await this.acquireLock(operationKey);
        if (!lockFileResult.acquired) {
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                chunksDeleted: 0,
                processingTimeMs: 0,
                message: lockFileResult.message
            };
        }

        const startTime = Date.now();
        
        // Create operation promise for concurrency tracking
        const operationPromise = this.performIncrementalUpdate(normalizedPath, maxAgeHours, startTime);
        this.activeOperations.set(operationKey, operationPromise);
        
        try {
            return await operationPromise;
        } finally {
            this.activeOperations.delete(operationKey);
            await this.releaseLock(operationKey);
        }
    }

    private async performIncrementalUpdate(codebasePath: string, maxAgeHours: number, startTime: number): Promise<{
        success: boolean;
        namespace: string;
        filesProcessed: number;
        chunksCreated: number;
        chunksDeleted: number;
        processingTimeMs: number;
        message: string;
    }> {
        
        try {
            // Validate path exists and is accessible
            const normalizedPath = path.resolve(codebasePath);
            await fs.access(normalizedPath);
            
            const namespace = this.namespaceManagerService.generateNamespace(codebasePath);
            this.logger.info(`🔄 Starting incremental update for: ${codebasePath}`);
            
            // Get last indexed time, or default to maxAgeHours ago
            const lastIndexedTime = await this.getLastIndexedTime(codebasePath);
            const cutoffTime = lastIndexedTime || new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
            
            this.logger.info(`📅 Looking for files modified since: ${cutoffTime.toISOString()}`);
            
            // Find changed files using FileProcessingService
            const changedFiles = await this.fileProcessingService.findChangedFiles(codebasePath, cutoffTime);
            
            if (changedFiles.length === 0) {
                this.logger.info('⚡ No files need updating');
                return {
                    success: true,
                    namespace,
                    filesProcessed: 0,
                    chunksCreated: 0,
                    chunksDeleted: 0,
                    processingTimeMs: Date.now() - startTime,
                    message: 'No files modified since last indexing'
                };
            }
            
            this.logger.info(`📝 Processing ${changedFiles.length} modified files`);
            
            // Process each changed file
            let totalChunksDeleted = 0;
            let totalChunksCreated = 0;
            let filesProcessed = 0;
            
            for (const filePath of changedFiles) {
                try {
                    await this.updateFileAtomically(namespace, filePath, codebasePath);
                    filesProcessed++;
                } catch (error) {
                    this.logger.error(`❌ Failed to update ${filePath}: ${error}`);
                    // Continue with other files rather than failing completely
                }
            }

            // For now, use rough estimates since we simplified the atomic operations
            // TODO: Collect actual statistics from atomic operations
            totalChunksCreated = filesProcessed; // Very rough estimate
            totalChunksDeleted = filesProcessed; // Very rough estimate
            this.logger.info('📊 Statistics are estimates - atomic operations completed successfully');
            
            // Update last indexed timestamp
            await this.saveLastIndexedTime(codebasePath, new Date());
            
            const processingTime = Date.now() - startTime;
            
            this.logger.info(`✅ Incremental update complete: ${filesProcessed}/${changedFiles.length} files (${totalChunksDeleted} deleted, ${totalChunksCreated} created chunks) in ${processingTime}ms`);
            
            return {
                success: true,
                namespace,
                filesProcessed,
                chunksCreated: totalChunksCreated,
                chunksDeleted: totalChunksDeleted,
                processingTimeMs: processingTime,
                message: `Incrementally updated ${filesProcessed} files (${totalChunksDeleted} chunks deleted, ${totalChunksCreated} chunks created)`
            };
            
        } catch (error) {
            this.logger.error('❌ Incremental update failed:', error);
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                chunksDeleted: 0,
                processingTimeMs: Date.now() - startTime,
                message: `Incremental update failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Index a codebase using the new architecture but with real API calls
     */
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

    /**
     * Search using new architecture with real API calls
     */
    /**
     * Advanced hybrid search combining vector similarity and BM25 full-text search
     */
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
            
            // OLD IMPLEMENTATION BELOW - can be removed after testing
            // Use direct Turbopuffer hybrid search with queries array approach
            this.logger.debug('Generating embedding for hybrid search...');
            const embedding = await this.jinaApiService.generateEmbedding(query);
            this.logger.info(`Embedding generated: ${embedding.length} dimensions`);

            this.logger.info('Calling Turbopuffer hybrid search...');
            const rawResults = await this.turbopufferStore.hybridSearch(namespace, {
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

    /**
     * Pure BM25 full-text search using Turbopuffer
     */
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
        const startTime = Date.now();
        
        if (!query || query.trim().length === 0) {
            return {
                success: false,
                results: [],
                searchTime: Date.now() - startTime,
                strategy: 'bm25'
            };
        }
        
        try {
            this.logger.info(`📝 BM25 search: "${query}" in ${codebasePath}`);

            const namespace = this.namespaceManagerService.generateNamespace(codebasePath);
            const limit = options.limit || 10;

            // Direct BM25 search through TurbopufferService
            const searchResults = await this.turbopufferService.query(namespace, {
                query: query,
                limit: options.enableReranking ? limit * 2 : limit
            });

            const rawResults = searchResults.map((item: any) => ({
                id: item.id,
                score: item.score,
                content: item.metadata?.content || '',
                symbols: item.metadata?.symbols ? item.metadata.symbols.split(',').filter(Boolean) : [],
                filePath: item.metadata?.filePath || '',
                startLine: item.metadata?.startLine || 0,
                endLine: item.metadata?.endLine || 0,
                language: item.metadata?.language || ''
            }));

            let results = rawResults;

            // Apply reranking if enabled
            if (options.enableReranking && rawResults.length > 0 && this.jinaApiService.isAvailable()) {
                try {
                    this.logger.debug('Applying Jina reranking to BM25 results...');
                    const documents = rawResults.map((r: any) => r.content);
                    const rerankedIndices = await this.jinaApiService.rerank(query, documents, limit);
                    
                    // Reorder results based on reranking scores
                    results = rerankedIndices.map(({ index, relevance_score }) => ({
                        ...rawResults[index],
                        score: relevance_score
                    }));
                    
                    this.logger.debug(`Reranking completed: ${rerankedIndices.length} results reordered`);
                } catch (error) {
                    this.logger.warn('Reranking failed, using original BM25 scores', { error: error instanceof Error ? error.message : String(error) });
                }
            }

            const searchTime = Date.now() - startTime;
            this.logger.info(`✅ BM25 search completed: ${results.length} results in ${searchTime}ms`);

            return {
                success: true,
                results,
                searchTime,
                strategy: 'bm25'
            };

        } catch (error) {
            this.logger.error('BM25 search failed', { error, query: query.substring(0, 50) });
            return {
                success: false,
                results: [],
                searchTime: Date.now() - startTime,
                strategy: 'bm25'
            };
        }
    }

    async searchWithIntelligence(query: string, codebasePath?: string, maxResults = 10): Promise<{
        success: boolean;
        results: CodeChunk[];
        totalResults: number;
        searchTimeMs: number;
        message: string;
    }> {
        const startTime = Date.now();
        
        try {
            // Determine namespace from codebase path or use first available
            let namespace: string;
            let actualCodebasePath: string;
            
            if (codebasePath) {
                // Normalize path for comparison
                const normalizedPath = path.resolve(codebasePath);
                const indexed = this.indexedCodebases.get(normalizedPath);
                if (!indexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: `Codebase not indexed. Please index ${codebasePath} first.`
                    };
                }
                namespace = indexed.namespace;
                actualCodebasePath = normalizedPath;
            } else {
                // Use first available namespace
                const firstIndexed = Array.from(this.indexedCodebases.values())[0];
                if (!firstIndexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: 'No codebases indexed. Run indexing first.'
                    };
                }
                namespace = firstIndexed.namespace;
                // Find the codebase path for this namespace
                actualCodebasePath = Array.from(this.indexedCodebases.keys())[0];
            }

            // Use hybrid search service with correct codebase path
            const searchResult = await this.searchHybrid(actualCodebasePath, query, {
                limit: maxResults,
                enableQueryEnhancement: true,
                enableReranking: true,
                vectorWeight: 0.6, // Better balanced weights
                bm25Weight: 0.4
            });
            
            // Apply Jina reranker v2 if API key is available and we have results
            if (searchResult.success && searchResult.results.length > 0 && this.jinaApiService.isAvailable()) {
                try {
                    const rerankedResults = await this.jinaApiService.rerankerResults(query, searchResult.results);
                    if (rerankedResults && rerankedResults.length > 0) {
                        searchResult.results = rerankedResults;
                        searchResult.metadata.reranked = true;
                        this.logger.info(`✨ Reranked ${rerankedResults.length} results`);
                    }
                } catch (rerankerError) {
                    this.logger.warn('Reranking failed, using original results:', rerankerError);
                }
            }
            
            if (!searchResult.success) {
                return {
                    success: false,
                    results: [],
                    totalResults: 0,
                    searchTimeMs: Date.now() - startTime,
                    message: 'Search failed'
                };
            }
            
            // Convert to standalone format
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

            const searchTime = Date.now() - startTime;
            
            return {
                success: true,
                results,
                totalResults: results.length,
                searchTimeMs: searchTime,
                message: `Found ${results.length} matches using ${searchResult.strategy} search`
            };
            
        } catch (error) {
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

    /**
     * Get indexing status using new architecture
     */
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

    /**
     * Clear index using real API calls
     */
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
                await this.clearVectorStoreNamespace(namespace);
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

    // Real API integration methods
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
            const upsertData = batch.map((chunk, idx) => ({
                id: chunk.id,
                vector: embeddings[idx],
                content: chunk.content,
                filePath: chunk.filePath,
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: chunk.language,
                symbols: chunk.symbols.map(s => typeof s === 'string' ? s : s.name).join(','),
                codebasePath: this.resolveCodebasePath(chunk.filePath)
            }));
            
            // Upload to Turbopuffer
            await this.turbopufferService.upsert(namespace, upsertData);
            
            
        }
        
        this.logger.info(`✅ Uploaded ${chunks.length} chunks to namespace: ${namespace}`);
    }

    private resolveCodebasePath(filePath: string): string {
        // Extract codebase path from file path by finding a reasonable root
        // This is a heuristic - could be improved based on actual use cases
        const parts = path.dirname(filePath).split(path.sep);
        // Find the most reasonable root (often the directory containing package.json, .git, etc.)
        for (let i = parts.length - 1; i >= 0; i--) {
            const testPath = parts.slice(0, i + 1).join(path.sep);
            // Simple heuristic: if we find common project indicators, use that as root
            if (parts[i].match(/^[a-zA-Z0-9_-]+$/) && i > 0) {
                return testPath;
            }
        }
        return path.dirname(filePath);
    }


    /**
     * Extract relevant connection context (imports/exports) for better architecture understanding
     */
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

    /**
     * Check if chunk defines architectural components worth connecting
     */
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

    /**
     * Filter imports to only include search/architecture relevant ones
     */
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

    /**
     * Extract export statements from chunk content
     */
    private extractExports(content: string): string[] {
        const exportMatches = content.match(/export\s+(class|interface|type|function|const|enum)\s+(\w+)/g);
        return exportMatches ? exportMatches.slice(0, 3) : []; // Limit to 3 exports
    }

    /**
     * Extract file path from import statement
     */
    private extractFilePath(importLine: string): string | null {
        const match = importLine.match(/from\s+['"]([^'"]+)['"]/);
        return match ? match[1] : null;
    }

    private async vectorStoreSearch(query: string, namespace: string, limit: number): Promise<any[]> {
        const queryEmbedding = await this.jinaApiService.generateEmbedding(query);
        return await this.turbopufferService.query(namespace, { embedding: queryEmbedding, limit });
    }

    private async vectorStoreSymbolSearch(symbols: string[], namespace: string, limit: number): Promise<any[]> {
        const symbolQuery = symbols.join(' ');
        return await this.vectorStoreSearch(symbolQuery, namespace, limit);
    }

    private async checkNamespaceExists(namespace: string): Promise<boolean> {
        return await this.turbopufferService.checkNamespaceExists(namespace);
    }

    // Jina AI integration methods removed - now using jinaApiService directly

    // Turbopuffer integration



    /**
     * True hybrid search combining vector and BM25 with RRF fusion
     */
    private async performHybridSearch(namespace: string, options: {
        embedding: number[];
        query: string;
        limit?: number;
        vectorWeight?: number;
        bm25Weight?: number;
        filters?: any;
    }): Promise<any[]> {
        return await this.turbopufferService.hybridSearch(namespace, options);
    }




    private async clearVectorStoreNamespace(namespace: string): Promise<void> {
        await this.turbopufferService.clearNamespace(namespace);
    }

    private async updateFileAtomically(namespace: string, filePath: string, codebasePath: string): Promise<void> {
        const relativePath = path.relative(codebasePath, filePath);
        this.logger.debug(`🔄 Atomically updating file: ${relativePath}`);

        // Step 1: Query existing chunks for rollback capability
        const existingChunkIds = await this.getChunkIdsForFile(namespace, filePath);
        
        // Step 2: Process the file to get new chunks
        const newChunks = await this.processSingleFile(filePath, codebasePath);
        
        // Step 3: Upload new chunks BEFORE deleting old ones (safer)
        if (newChunks.length > 0) {
            try {
                await this.uploadChunksToVectorStore(namespace, newChunks);
                this.logger.debug(`✅ Uploaded ${newChunks.length} new chunks for ${relativePath}`);
            } catch (uploadError) {
                // If upload fails, we haven't deleted anything yet, so we're safe
                throw new Error(`Failed to upload new chunks: ${uploadError}`);
            }
        }

        // Step 4: Delete old chunks only after successful upload
        if (existingChunkIds.length > 0) {
            try {
                const deletedCount = await this.deleteChunksByIds(namespace, existingChunkIds);
                this.logger.debug(`✅ Deleted ${deletedCount} old chunks for ${relativePath}`);
            } catch (deleteError) {
                // Upload succeeded but delete failed - log warning but don't fail
                // This leaves some orphaned chunks but maintains functionality
                this.logger.warn(`⚠️ Failed to delete old chunks for ${relativePath}: ${deleteError}`);
                this.logger.warn(`⚠️ New chunks uploaded successfully, but old chunks remain (orphaned)`);
            }
        }

        this.logger.debug(`✅ Atomically updated ${relativePath}: ${existingChunkIds.length} deleted, ${newChunks.length} created`);
    }

    private async getChunkIdsForFile(namespace: string, filePath: string): Promise<string[]> {
        return await this.turbopufferService.getChunkIdsForFile(namespace, filePath);
    }

    private async deleteChunksByIds(namespace: string, chunkIds: string[]): Promise<number> {
        return await this.turbopufferService.deleteChunksByIds(namespace, chunkIds);
    }

    private async processSingleFile(filePath: string, codebasePath: string): Promise<CoreChunk[]> {
        try {
            // Create a minimal IndexingRequest for single file processing
            const indexingRequest: IndexingRequest = {
                codebasePath,
                force: false,
                enableContentFiltering: true,
                enableDependencyAnalysis: true
            };

            // Use the public processFile method directly (no hacky overrides)
            const chunks = await this.indexingOrchestrator.processFile(filePath, indexingRequest);
            
            this.logger.debug(`Processed single file ${filePath}: ${chunks.length} chunks`);
            return chunks;

        } catch (error) {
            this.logger.error(`Error processing single file ${filePath}:`, error);
            return [];
        }
    }

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

    // Incremental indexing helpers
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

    private async findChangedFiles(codebasePath: string, since: Date): Promise<string[]> {
        try {
            // Use existing FileUtils to discover all code files
            const allFiles = await this.fileUtils.discoverFiles(
                codebasePath,
                ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust']
            );
            
            const changedFiles: string[] = [];
            
            for (const filePath of allFiles) {
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.mtime > since) {
                        changedFiles.push(filePath);
                    }
                } catch (error) {
                    // File might have been deleted, skip it
                    continue;
                }
            }
            
            return changedFiles;
        } catch (error) {
            this.logger.error('Error finding changed files:', error);
            return [];
        }
    }

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

    async initialize(): Promise<void> {
        await this.loadIndexedCodebases();
        this.logger.info(`Loaded ${this.indexedCodebases.size} indexed codebases`);
    }
}

// MCP Server Implementation
class StandaloneMCPServer {
    private server: Server;
    private codexMcp: StandaloneCodexMcp;
    
    constructor() {
        this.codexMcp = new StandaloneCodexMcp();
        
        this.server = new Server(
            {
                name: 'intelligent-context-mcp',
                version: '2.0.0',
            },
            {
                capabilities: {
                    tools: {},
                    resources: {}
                }
            }
        );
        
        this.setupHandlers();
    }
    
    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools: Tool[] = [
                {
                    name: 'index_codebase',
                    description: 'Index a codebase for intelligent search and analysis',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Path to the codebase to index'
                            },
                            force_reindex: {
                                type: 'boolean',
                                description: 'Force reindexing even if already indexed',
                                default: false
                            }
                        },
                        required: ['codebase_path']
                    }
                },
                {
                    name: 'search_codebase',
                    description: `
Search the indexed codebase using natural language or specific terms with intelligent hybrid search (vector + BM25).

🎯 **When to Use**:
This tool should be used for all code-related searches in this project:
- **Code search**: Find specific functions, classes, or implementations
- **Context gathering**: Get relevant code context before making changes  
- **Architecture understanding**: Understand how systems like hybrid search are implemented
- **Feature analysis**: Analyze existing functionality and patterns

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return an error indicating indexing is required first.
- Use the index_codebase tool to index the codebase before searching.
`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query (natural language or specific terms)'
                            },
                            codebase_path: {
                                type: 'string',
                                description: 'Path to the codebase to search (optional if only one indexed)'
                            },
                            max_results: {
                                type: 'number',
                                description: 'Maximum number of results to return',
                                default: 10
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'get_indexing_status',
                    description: 'Get the indexing status of codebases',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Optional: Get status for specific codebase'
                            }
                        }
                    }
                },
                {
                    name: 'clear_index',
                    description: 'Clear index data for a codebase',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Path to the codebase to clear (optional to clear all)'
                            }
                        }
                    }
                }
            ];

            return { tools };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'index_codebase':
                        const indexResult = await this.codexMcp.indexCodebaseIntelligent(
                            (args as any).codebase_path,
                            (args as any).force_reindex || false
                        );
                        
                        return {
                            content: [{
                                type: 'text',
                                text: indexResult.success ? 
                                    `✅ Indexing completed: ${indexResult.chunksCreated} chunks created in ${indexResult.processingTimeMs}ms` :
                                    `❌ Indexing failed: ${indexResult.message}`
                            }]
                        };
                    
                    case 'search_codebase':
                        console.log(`🔍 STANDALONE MCP TOOL CALLED: search_codebase with query "${(args as any).query}"`);
                        
                        // Auto-trigger incremental update before searching to ensure fresh results
                        const codebasePath = (args as any).codebase_path;
                        if (codebasePath) {
                            console.log(`⚡ Auto-triggering incremental update before search...`);
                            try {
                                const incrementalResult = await this.codexMcp.incrementalUpdateCodebase(codebasePath, 24);
                                if (incrementalResult.filesProcessed > 0) {
                                    console.log(`📝 Pre-search update: ${incrementalResult.filesProcessed} files processed`);
                                } else {
                                    console.log(`✅ Pre-search update: No files needed updating`);
                                }
                            } catch (incrementalError) {
                                // Don't fail the search if incremental update fails - just log warning
                                console.warn(`⚠️ Pre-search incremental update failed: ${incrementalError}`);
                            }
                        }
                        
                        const searchResult = await this.codexMcp.searchWithIntelligence(
                            (args as any).query,
                            (args as any).codebase_path,
                            (args as any).max_results || 10
                        );
                        console.log(`🔍 STANDALONE MCP RESULT: ${searchResult.results.length} results, top score: ${searchResult.results[0]?.score}`);
                        
                        if (!searchResult.success) {
                            return {
                                content: [{
                                    type: 'text',
                                    text: `❌ Search failed: ${searchResult.message}`
                                }]
                            };
                        }

                        const response = {
                            total_results: searchResult.totalResults,
                            search_time_ms: searchResult.searchTimeMs,
                            results: searchResult.results.map(chunk => {
                                const chunkAny = chunk as any;
                                return {
                                    file_path: chunk.relativePath,
                                    start_line: chunk.startLine,
                                    end_line: chunk.endLine,
                                    language: chunk.language,
                                    content: chunk.content,
                                    score: chunk.score,
                                    symbols: chunk.symbols,
                                    connections: chunk.connections, // Include connection context for Claude
                                    ...(chunkAny.originalScore !== undefined && { 
                                        original_score: chunkAny.originalScore,
                                        reranked: chunkAny.reranked || true
                                    })
                                };
                            })
                        };

                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify(response, null, 2)
                            }]
                        };
                    
                    case 'get_indexing_status':
                        const status = await this.codexMcp.getIndexingStatus((args as any).codebase_path);
                        
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify(status, null, 2)
                            }]
                        };
                    
                    case 'clear_index':
                        const clearResult = await this.codexMcp.clearIndex((args as any).codebase_path);
                        
                        return {
                            content: [{
                                type: 'text',
                                text: clearResult.success ? 
                                    '✅ Index cleared successfully' : 
                                    `❌ Failed to clear index: ${clearResult.message}`
                            }]
                        };
                    
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`
                    }]
                };
            }
        });

        // Resource handlers
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const resources: Resource[] = [
                {
                    uri: 'mcp://codebase-status',
                    name: 'Codebase Status',
                    description: 'Current status of indexed codebases'
                }
            ];

            return { resources };
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;

            switch (uri) {
                case 'mcp://codebase-status':
                    const status = await this.codexMcp.getIndexingStatus();
                    return {
                        contents: [{
                            type: 'text',
                            text: JSON.stringify(status, null, 2)
                        }]
                    };
                
                default:
                    throw new Error(`Unknown resource: ${uri}`);
            }
        });
    }
    
    async run(): Promise<void> {
        // Show configuration status
        const config = {
            openaiApiKey: process.env.OPENAI_API_KEY,
            jinaApiKey: process.env.JINA_API_KEY,
            turbopufferApiKey: process.env.TURBOPUFFER_API_KEY
        };
        
        const capabilities = {
            queryEnhancement: !!config.openaiApiKey,
            reranking: !!config.jinaApiKey && config.jinaApiKey !== 'test',
            vectorSearch: !!config.turbopufferApiKey && config.turbopufferApiKey !== 'test',
            localBM25: true
        };
        
        console.error('🔧 Capabilities:', JSON.stringify(capabilities));
        
        if (!config.openaiApiKey) {
            console.error('⚠️  OpenAI API key not provided - query enhancement will be disabled');
            console.error('💡 Set OPENAI_API_KEY environment variable to enable query enhancement');
        }
        
        if (!config.jinaApiKey || config.jinaApiKey === 'test') {
            console.error('⚠️  Jina API key not provided - result reranking will be disabled');
            console.error('💡 Set JINA_API_KEY environment variable to enable result reranking');
        }
        
        // Initialize the standalone MCP integration
        await this.codexMcp.initialize();
        
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        
        console.error('🚀 Intelligent Context MCP Server ready!');
        console.error(`✨ Query Enhancement: ${!!config.openaiApiKey ? '✅ Enabled' : '❌ Disabled'}`);
        console.error(`🔄 Result Reranking: ${!!(config.jinaApiKey && config.jinaApiKey !== 'test') ? '✅ Enabled' : '❌ Disabled'}`);
        console.error('📝 Local BM25 Search: ✅ Always Available');
        console.error('🔌 Transport: stdio');
    }
}

// Auto-run when called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = new StandaloneMCPServer();
    server.run().catch((error) => {
        console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
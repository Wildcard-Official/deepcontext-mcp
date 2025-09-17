/**
 * Standalone MCP Integration
 * Provides intelligent codebase indexing and search capabilities via Model Context Protocol.
 * Delegates to specialized services for file processing, namespace management, and search coordination.
 */

import * as path from 'path';

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
import { TreeSitterSymbolExtractorFull } from './core/indexing/TreeSitterSymbolExtractor.treesitter-based.js';
import { LanguageDetector } from './utils/LanguageDetector.js';
import { Logger } from './utils/Logger.js';
import { JinaApiService } from './services/JinaApiService.js';
import { TurbopufferService } from './services/TurbopufferService.js';
import { ConfigurationService } from './services/ConfigurationService.js';
import { NamespaceManagerService, IndexedCodebase } from './services/NamespaceManagerService.js';
import { FileProcessingService } from './services/FileProcessingService.js';
import { SearchCoordinationService } from './services/SearchCoordinationService.js';
import { SemanticSubChunker } from './services/SemanticSubChunker.js';
import { CodeChunk } from './types/core.js';
import { McpConfig } from './services/ConfigurationService.js';

export class StandaloneCodexMcp {
    private config: McpConfig;
    public indexingOrchestrator: IndexingOrchestrator;
    private languageDetector: LanguageDetector;
    private logger: Logger;
    private jinaApiService: JinaApiService;
    private turbopufferService: TurbopufferService;
    private configurationService: ConfigurationService;
    private namespaceManagerService: NamespaceManagerService;
    private fileProcessingService: FileProcessingService;
    private searchCoordinationService: SearchCoordinationService;
    private symbolExtractor: TreeSitterSymbolExtractorFull;
    private semanticSubChunker: SemanticSubChunker;

    constructor(config?: Partial<McpConfig>) {
        // Initialize ConfigurationService with provided config
        this.configurationService = new ConfigurationService(config, { logConfigurationStatus: false });
        this.config = this.configurationService.getConfig();
        
        this.logger = new Logger('STANDALONE-INTEGRATION', this.config.logLevel);
        this.languageDetector = new LanguageDetector();
        this.jinaApiService = new JinaApiService(this.config.jinaApiKey);
        this.turbopufferService = new TurbopufferService(this.config.turbopufferApiKey);
        this.symbolExtractor = new TreeSitterSymbolExtractorFull();
        this.semanticSubChunker = new SemanticSubChunker();

        // Initialize NamespaceManagerService first (needed for metadata callback)
        this.namespaceManagerService = new NamespaceManagerService(this.turbopufferService);
        
        // Initialize FileProcessingService with integrated chunk operations
        const chunkOperations = {
            getChunkIdsForFile: async (namespace: string, filePath: string) => {
                return await this.turbopufferService.getChunkIdsForFile(namespace, filePath);
            },
            deleteChunksByIds: async (namespace: string, chunkIds: string[]) => {
                return await this.turbopufferService.deleteChunksByIds(namespace, chunkIds);
            },
            uploadChunks: async (namespace: string, chunks: any[]) => {
                try {
                    if (!chunks.length) {
                        this.logger.debug('No chunks to upload');
                        return;
                    }

                    this.logger.info(`Processing ${chunks.length} chunks for semantic sub-chunking...`);

                    // Step 1: Process chunks through semantic sub-chunker to prevent truncation
                    const processedChunks: any[] = [];
                    let totalSubChunks = 0;

                    for (const chunk of chunks) {
                        const subChunks = await this.semanticSubChunker.splitLargeChunk(chunk);
                        processedChunks.push(...subChunks);

                        if (subChunks.length > 1) {
                            totalSubChunks += subChunks.length;
                            this.logger.debug(`Split large chunk ${chunk.id} into ${subChunks.length} sub-chunks`);
                        }
                    }

                    if (totalSubChunks > chunks.length) {
                        this.logger.info(`✂️ Created ${totalSubChunks - chunks.length} additional sub-chunks to prevent content loss`);
                    }

                    this.logger.info(`Uploading ${processedChunks.length} processed chunks to namespace: ${namespace}`);

                    // Step 2: Process chunks in batches for embedding generation
                    const BATCH_SIZE = 50;
                    for (let i = 0; i < processedChunks.length; i += BATCH_SIZE) {
                        const batch = processedChunks.slice(i, i + BATCH_SIZE);

                        // Validate chunk sizes before embedding
                        for (const chunk of batch) {
                            if (chunk.content.length > 20000) {
                                this.logger.warn(`⚠️ Chunk ${chunk.id} still exceeds 20K chars (${chunk.content.length}) - may cause embedding errors`);
                            }
                        }

                        // Generate embeddings for the batch
                        const embeddings = await this.jinaApiService.generateEmbeddingBatch(
                            batch.map(chunk => chunk.content)
                        );

                        // Prepare data for Turbopuffer upsert
                        const upsertData = batch.map((chunk, idx) => ({
                            id: chunk.id,
                            vector: embeddings[idx],
                            content: chunk.content,
                            filePath: chunk.filePath,
                            startLine: chunk.startLine,
                            endLine: chunk.endLine,
                            language: chunk.language,
                            // Handle both IndexingOrchestrator format and core.ts format
                            symbols: chunk.symbols?.map((s: any) =>
                                typeof s === 'string' ? s : s.name || s
                            ).join(', ') || ''
                        }));

                        // Upload to vector store
                        await this.turbopufferService.upsert(namespace, upsertData);

                        this.logger.debug(`Uploaded batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(processedChunks.length/BATCH_SIZE)} (${batch.length} chunks)`);
                    }

                    this.logger.info(`✅ Successfully uploaded ${processedChunks.length} chunks to ${namespace} (${totalSubChunks - chunks.length} additional sub-chunks created)`);
                } catch (error) {
                    this.logger.error(`Failed to upload chunks to ${namespace}:`, error);
                    throw error;
                }
            }
        };
        this.fileProcessingService = new FileProcessingService(chunkOperations);

        // Create metadata callback for IndexingOrchestrator - now that NamespaceManagerService is ready
        const metadataCallback = async (codebasePath: string, indexedData: any) => {
            await this.namespaceManagerService.registerCodebase(
                
                codebasePath,
                indexedData.totalChunks,
                new Date(indexedData.indexedAt)
            );
            await this.fileProcessingService.saveLastIndexedTime(codebasePath, new Date());
        };

        // Initialize IndexingOrchestrator with enhanced services
        this.indexingOrchestrator = new IndexingOrchestrator({
            jinaApiService: this.jinaApiService,
            turbopufferService: this.turbopufferService,
            namespaceManagerService: this.namespaceManagerService,
            metadataCallback
        });

        // Initialize SearchCoordinationService with connection context extractor
        const connectionExtractor = async (filePath: string, content: string) => {
            return await this.extractConnectionContext(filePath, content);
        };
        this.searchCoordinationService = new SearchCoordinationService(
            this.jinaApiService,
            this.turbopufferService,
            connectionExtractor,
            'SearchCoordinationService'
        );
        
    }


    /**
     * Index a codebase using the enhanced IndexingOrchestrator
     */
    async indexCodebase(codebasePath: string, forceReindex = false): Promise<{
        success: boolean;
        namespace: string;
        filesProcessed: number;
        chunksCreated: number;
        processingTimeMs: number;
        message: string;
    }> {
        const indexingRequest = {
            codebasePath,
            forceReindex: forceReindex,
            enableContentFiltering: true,
            enableDependencyAnalysis: true
        };
        
        const indexResult = await this.indexingOrchestrator.indexCodebase(indexingRequest);
        
        return {
            success: indexResult.success,
            namespace: indexResult.metadata?.namespace || '',
            filesProcessed: indexResult.metadata?.totalFiles || 0,
            chunksCreated: indexResult.chunks?.length || 0,
            processingTimeMs: indexResult.metadata?.indexingTime || 0,
            message: indexResult.success 
                ? `Successfully indexed ${indexResult.metadata?.totalFiles || 0} files into ${indexResult.chunks?.length || 0} intelligent chunks`
                : `Indexing failed with ${indexResult.errors?.length || 0} errors`        
            };
    }

    /**
     * Hybrid search using SearchCoordinationService
     */
    async searchHybrid(codebasePath: string, query: string, options: {
        limit?: number;
        vectorWeight?: number;
        bm25Weight?: number;
        fileTypes?: string[];
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
            reranked: boolean;
        };
    }> {
        // Ensure index is up-to-date before searching
        await this.ensureUpToDateIndex(codebasePath);

        // Get namespace from registered codebase instead of generating it
        const normalizedPath = path.resolve(codebasePath);
        const indexed = this.namespaceManagerService.getIndexedCodebase(normalizedPath);
        if (!indexed) {
            return {
                success: false,
                results: [],
                searchTime: 0,
                strategy: 'hybrid',
                metadata: {
                    vectorResults: 0,
                    bm25Results: 0,
                    totalMatches: 0,
                    reranked: false
                }
            };
        }

        const namespace = indexed.namespace;
        const searchResult = await this.searchCoordinationService.searchHybrid(namespace, query, {
            limit: options.limit || 10,
            vectorWeight: options.vectorWeight || 0.1,
            bm25Weight: options.bm25Weight || 0.9
        });

        return {
            success: searchResult.success,
            results: searchResult.results,
            searchTime: searchResult.searchTime,
            strategy: searchResult.strategy,
            metadata: {
                vectorResults: searchResult.metadata?.vectorResults || 0,
                bm25Results: searchResult.metadata?.bm25Results || 0,
                totalMatches: searchResult.metadata?.totalMatches || searchResult.results.length,
                reranked: searchResult.metadata?.reranked || (options.enableReranking !== false)
            }
        };
    }

    /**
     * BM25 search using SearchCoordinationService
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
        // Ensure index is up-to-date before searching
        await this.ensureUpToDateIndex(codebasePath);

        // Get namespace from registered codebase instead of generating it
        const normalizedPath = path.resolve(codebasePath);
        const indexed = this.namespaceManagerService.getIndexedCodebase(normalizedPath);
        if (!indexed) {
            return {
                success: false,
                results: [],
                searchTime: 0,
                strategy: 'bm25'
            };
        }

        const namespace = indexed.namespace;
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
    }

    /**
     * Intelligent search using SearchCoordinationService
     */
    async searchWithIntelligence(query: string, codebasePath?: string, maxResults = 10): Promise<{
        success: boolean;
        results: CodeChunk[];
        totalResults: number;
        searchTimeMs: number;
        message: string;
    }> {
        // Ensure index is up-to-date before searching
        if (codebasePath) {
            await this.ensureUpToDateIndex(codebasePath);
        }

        const searchResult = await this.searchCoordinationService.searchWithIntelligence(
            query,
            codebasePath,
            this.namespaceManagerService.getAllIndexedCodebases(),
            maxResults
        );
        
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
                connections: result.connections
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
    }

    /**
     * Get indexing status via NamespaceManagerService
     */
    async getIndexingStatus(codebasePath?: string): Promise<{
        indexedCodebases: IndexedCodebase[];
        currentCodebase?: IndexedCodebase;
        incrementalStats?: any;
        indexed: boolean;
        fileCount: number;
    }> {
        return await this.namespaceManagerService.getIndexingStatus(codebasePath);
    }

    /**
     * Clear index via NamespaceManagerService
     */
    async clearIndex(codebasePath?: string): Promise<{
        success: boolean;
        message: string;
        namespacesCleared: string[];
    }> {
        // NamespaceManagerService handles both registry clearing and vector store clearing
        return await this.namespaceManagerService.clearIndexedCodebases(codebasePath);
    }


    /**
     * Extract relevant connection context using TreeSitterSymbolExtractorFull
     */
    private async extractConnectionContext(
        filePath: string,
        chunkContent: string
    ): Promise<{ imports: string[]; exports: string[]; relatedFiles: string[] }> {
        try {
            // Initialize symbol extractor if needed
            await this.symbolExtractor.initialize();

            // Read the full file content to get imports/exports (they're usually at file level)
            const fs = await import('fs/promises');
            const fullFileContent = await fs.readFile(filePath, 'utf-8');

            // Detect language from full file
            const language = this.languageDetector.detectLanguage(filePath, fullFileContent);

            // Use TreeSitterSymbolExtractorFull for accurate import/export extraction on full file
            const symbolResult = await this.symbolExtractor.extractSymbols(
                fullFileContent,
                language.language,
                filePath
            );

            const result = {
                imports: symbolResult.imports.map(imp => imp.module).filter(Boolean).slice(0, 5),
                exports: symbolResult.exports.slice(0, 5),
                relatedFiles: symbolResult.imports.map(imp => imp.module).filter(Boolean).slice(0, 5)
            };

            this.logger.debug(`🔗 Extracted connections for ${filePath}:`);
            this.logger.debug(`   Full file content length: ${fullFileContent.length} chars`);
            this.logger.debug(`   Raw imports: ${JSON.stringify(symbolResult.imports)}`);
            this.logger.debug(`   Raw exports: ${JSON.stringify(symbolResult.exports)}`);
            this.logger.debug(`   Final result: ${result.imports.length} imports, ${result.exports.length} exports`);
            return result;

        } catch (error) {
            this.logger.debug('Failed to extract connection context:', error);
            return { imports: [], exports: [], relatedFiles: [] };
        }
    }

    /**
     * Ensure the index is up-to-date by running hash-based incremental indexing before searches
     */
    private async ensureUpToDateIndex(codebasePath: string): Promise<void> {
        try {
            const normalizedPath = path.resolve(codebasePath);
            const indexed = this.namespaceManagerService.getIndexedCodebase(normalizedPath);

            if (!indexed) {
                this.logger.debug(`Codebase not indexed, skipping incremental update: ${codebasePath}`);
                return;
            }

            this.logger.debug(`🔄 Running hash-based incremental indexing before search for: ${codebasePath}`);

            // Run incremental update with hash-based change detection (no time limits)
            const incrementalResult = await this.fileProcessingService.processIncrementalUpdate(
                normalizedPath,
                indexed.namespace,
                {} // No maxAgeHours - relies on hash-based change detection
            );

            if (incrementalResult.success && incrementalResult.filesProcessed > 0) {
                this.logger.info(`✅ Hash-based incremental update: ${incrementalResult.filesProcessed} files with actual changes processed`);

                // Update last indexed time for tracking purposes
                await this.fileProcessingService.saveLastIndexedTime(normalizedPath, new Date());
            } else {
                this.logger.debug(`⚡ No files with content changes found for: ${codebasePath}`);
            }

        } catch (error) {
            this.logger.warn('Failed to run incremental indexing before search:', error);
            // Don't fail the search if incremental indexing fails
        }
    }

    async initialize(): Promise<void> {
        await this.namespaceManagerService.initialize();
        await this.symbolExtractor.initialize();
        this.logger.info(`Initialized with ${this.namespaceManagerService.getAllIndexedCodebases().size} indexed codebases`);
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
                    description: `Prepares a codebase for intelligent search by creating a searchable index.

**When to use**: Call this first before searching any new codebase. Required prerequisite for search_codebase.

**Use force_reindex=true when**: Code has changed significantly or search results seem outdated.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Absolute path to the directory containing source code files'
                            },
                            force_reindex: {
                                type: 'boolean',
                                description: 'Force complete reindexing even if already indexed (default: false)',
                                default: false
                            }
                        },
                        required: ['codebase_path']
                    }
                },
                {
                    name: 'search_codebase',
                    description: `Finds relevant code in an indexed codebase using natural language or keyword queries.

**When to use**:
- Find specific functions, classes, or code patterns
- Get context before making changes to understand dependencies
- Explore how existing systems work
- Locate examples of API usage or patterns

**Returns**: Code chunks with file paths, line numbers, and relevance scores.

**Prerequisite**: Codebase must be indexed first with index_codebase.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Natural language or keyword search query describing what code to find'
                            },
                            codebase_path: {
                                type: 'string',
                                description: 'Absolute path to the codebase to search (optional if only one codebase indexed)'
                            },
                            max_results: {
                                type: 'number',
                                description: 'Maximum number of code chunks to return (default: 5)',
                                default: 5
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    name: 'get_indexing_status',
                    description: `Check if codebases are indexed and get their status information.

**When to use**:
- Before indexing to check if already done
- Debug why search returned no results
- Confirm indexing completed successfully
- Get overview of all indexed codebases

**Returns**: Indexing status, file counts, and timestamps.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Optional: Absolute path to specific codebase to check. Omit to get status of all indexed codebases'
                            }
                        }
                    }
                },
                {
                    name: 'clear_index',
                    description: `Permanently removes all indexed data for a codebase.

**When to use**:
- Clear stale data before reindexing after major code changes
- Remove old indexed codebases no longer needed
- Fix corrupted index causing search issues

**Warning**: Destructive operation. All search capabilities lost until reindexing.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string',
                                description: 'Absolute path to the codebase to clear. Omit to clear ALL indexed codebases (use with caution)'
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
                        try {
                            // Resolve relative paths to absolute paths
                            const codebasePath = path.resolve((args as any).codebase_path);
                            console.log(`🔍 Indexing path: ${(args as any).codebase_path} -> ${codebasePath}`);

                            const indexResult = await this.codexMcp.indexCodebase(
                                codebasePath,
                                (args as any).force_reindex || false
                            );

                            if (indexResult.success) {
                                return {
                                    content: [{
                                        type: 'text',
                                        text: `✅ Indexing completed: ${indexResult.chunksCreated} chunks created in ${indexResult.processingTimeMs}ms`
                                    }]
                                };
                            } else {
                                // Provide detailed error information
                                return {
                                    content: [{
                                        type: 'text',
                                        text: `❌ Indexing failed: ${indexResult.message}\n\nDetailed Results:\n${JSON.stringify(indexResult, null, 2)}`
                                    }]
                                };
                            }
                        } catch (error) {
                            // Catch any unhandled errors
                            return {
                                content: [{
                                    type: 'text',
                                    text: `❌ Indexing error: ${error instanceof Error ? error.message : String(error)}\n\nStack trace:\n${error instanceof Error ? error.stack : 'No stack trace available'}`
                                }]
                            };
                        }
                    
                    case 'search_codebase':
                        console.log(`🔍 STANDALONE MCP TOOL CALLED: search_codebase with query "${(args as any).query}"`);
                        
                        // Note: Incremental indexing is automatically triggered before each search
                        const searchResult = await this.codexMcp.searchWithIntelligence(
                            (args as any).query,
                            (args as any).codebase_path,
                            (args as any).max_results || 5
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
            jinaApiKey: process.env.JINA_API_KEY,
            turbopufferApiKey: process.env.TURBOPUFFER_API_KEY
        };

        const capabilities = {
            reranking: !!config.jinaApiKey && config.jinaApiKey !== 'test',
            vectorSearch: !!config.turbopufferApiKey && config.turbopufferApiKey !== 'test',
            localBM25: true
        };

        console.error('🔧 Capabilities:', JSON.stringify(capabilities));

        // Wildcard hosted backend mode indicator
        const wildcardEnabled = !!process.env.WILDCARD_API_KEY;
        const wildcardUrl = process.env.WILDCARD_API_URL || 'https://intelligent-context-backend.onrender.com' || 'http://localhost:4000';
        if (wildcardEnabled) {
            console.error(`🌐 Wildcard backend: ENABLED (using hosted Fastify backend)`);
            console.error(`   Base URL: ${wildcardUrl}`);
        } else {
            console.error(`🌐 Wildcard backend: disabled (direct provider mode)`);
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
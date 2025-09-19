#!/usr/bin/env node
/**
 * Standalone MCP Integration
 * Provides intelligent codebase indexing and search capabilities via Model Context Protocol.
 * Delegates to specialized services for file processing, namespace management, and search coordination.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export class StandaloneContextMcp {
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
        this.jinaApiService = new JinaApiService(this.config.jinaApiKey, this.configurationService);
        this.turbopufferService = new TurbopufferService(this.config.turbopufferApiKey, this.configurationService);
        this.symbolExtractor = new TreeSitterSymbolExtractorFull();
        this.semanticSubChunker = new SemanticSubChunker(this.configurationService);

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
                    const BATCH_SIZE = 10; // Optimal batch size for embedding generation
                    for (let i = 0; i < processedChunks.length; i += BATCH_SIZE) {
                        const batch = processedChunks.slice(i, i + BATCH_SIZE);

                        // Validate chunk sizes before embedding
                        const chunkingConfig = this.configurationService.getChunkingConfig();
                        for (const chunk of batch) {
                            if (chunk.content.length > chunkingConfig.jinaMaxChars) {
                                this.logger.warn(`⚠️ Chunk ${chunk.id} still exceeds ${chunkingConfig.jinaMaxChars} chars (${chunk.content.length}) - may cause embedding errors`);
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
            this.configurationService,
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
        errors?: Array<{ file: string; error: string }>;
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
                : `Indexing failed with ${indexResult.errors?.length || 0} errors`,
            errors: indexResult.errors
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
        const searchConfig = this.configurationService.getSearchConfig();
        const searchResult = await this.searchCoordinationService.searchHybrid(namespace, query, {
            limit: options.limit || searchConfig.defaultResultLimit,
            vectorWeight: options.vectorWeight || searchConfig.defaultVectorWeight,
            bm25Weight: options.bm25Weight || searchConfig.defaultBm25Weight
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
        const searchConfig = this.configurationService.getSearchConfig();
        const searchResult = await this.searchCoordinationService.searchBM25(namespace, query, {
            limit: options.limit || searchConfig.defaultResultLimit,
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
    async searchWithIntelligence(query: string, codebasePath?: string, maxResults?: number): Promise<{
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

        const searchConfig = this.configurationService.getSearchConfig();
        const indexedCodebases = await this.namespaceManagerService.getAllIndexedCodebases();
        const searchResult = await this.searchCoordinationService.searchWithIntelligence(
            query,
            codebasePath,
            indexedCodebases,
            maxResults || searchConfig.defaultResultLimit
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
        const indexedCodebases = await this.namespaceManagerService.getAllIndexedCodebases();
        this.logger.info(`Initialized with ${indexedCodebases.size} indexed codebases`);
    }
}

// MCP Server Implementation
class StandaloneMCPServer {
    private server: Server;
    private contextMcp: StandaloneContextMcp;
    
    constructor() {
        this.contextMcp = new StandaloneContextMcp();
        
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
        
        // Initialize the registry on startup to ensure it's loaded for new sessions
        this.initializeRegistry();
    }
    
    private async initializeRegistry(): Promise<void> {
        try {
            await this.contextMcp.initialize();
            console.error(`🔍 Registry initialized successfully`);
        } catch (error) {
            console.error(`⚠️ Failed to initialize registry:`, error);
        }
    }
    
    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools: Tool[] = [
                {
                    name: 'index_codebase',
                    description: `<tool>
  <purpose>Prepares a codebase for intelligent search by creating a searchable index</purpose>

  <when_to_use>
    <scenario>Call this first before searching any new codebase</scenario>
    <scenario>Required prerequisite for search_codebase</scenario>
  </when_to_use>

  <parameters>
    <parameter name="codebase_path" required="true">
      <type>string</type>
      <description>ABSOLUTE path to the directory containing source code files</description>
      <examples>
        <valid>/Users/name/project</valid>
        <valid>/home/user/code/repo</valid>
        <invalid>.</invalid>
        <invalid>../project</invalid>
        <invalid>relative/path</invalid>
      </examples>
      <validation>Must be absolute path starting with / (Unix) or C:\\ (Windows)</validation>
    </parameter>

    <parameter name="force_reindex" required="false">
      <type>boolean</type>
      <description>Force complete reindexing even if already indexed</description>
      <default>false</default>
      <when_to_use>Code has changed significantly or search results seem outdated</when_to_use>
    </parameter>
  </parameters>
</tool>`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string'
                            },
                            force_reindex: {
                                type: 'boolean',
                                default: false
                            }
                        },
                        required: ['codebase_path']
                    }
                },
                {
                    name: 'search_codebase',
                    description: `<tool>
  <purpose>Finds relevant code in an indexed codebase using natural language or keyword queries</purpose>

  <when_to_use>
    <scenario>Find specific functions, classes, or code patterns</scenario>
    <scenario>Get context before making changes to understand dependencies</scenario>
    <scenario>Explore how existing systems work</scenario>
    <scenario>Locate examples of API usage or patterns</scenario>
  </when_to_use>

  <parameters>
    <parameter name="query" required="true">
      <type>string</type>
      <description>Natural language or keyword search query describing what code to find</description>
    </parameter>

    <parameter name="codebase_path" required="true">
      <type>string</type>
      <description>ABSOLUTE path to the codebase directory to search</description>
      <examples>
        <valid>/Users/name/project</valid>
        <valid>/home/user/code/repo</valid>
        <invalid>.</invalid>
        <invalid>../project</invalid>
        <invalid>relative/path</invalid>
      </examples>
      <validation>Must be absolute path starting with / (Unix) or C:\\ (Windows)</validation>
    </parameter>

    <parameter name="max_results" required="false">
      <type>number</type>
      <description>Maximum number of code chunks to return</description>
      <default>5</default>
      <best_practice>Keep at default 5 for focused results. Use multiple targeted searches rather than increasing this limit</best_practice>
    </parameter>
  </parameters>

  <strategy>
    <guideline>Use specific technical terms: "authentication middleware", "database connection", "error handler"</guideline>
    <guideline>Focus on implementation: "user login function" rather than "user management system"</guideline>
    <guideline>Include file types when relevant: "SQL migration", "React component", "API endpoint"</guideline>
  </strategy>

  <workflow>
    <step>Search discovers relevant files and entry points, use imports and exports to find related files</step>
    <step>Use Read tool to explore discovered files in detail for complete implementation</step>
    <step>Use Grep tool for precise pattern matching of specific symbols or exact text</step>
    <step>Follow imports/exports from results to guide next searches</step>
    <step>Prefer multiple focused searches with 5 results over single large searches</step>
    <step>Search provides discovery, not complete solutions</step>
  </workflow>

  <result_interpretation>
    <point>Results ranked by semantic relevance, not code importance</point>
    <point>Implementation code often appears in results 2-5, not just #1</point>
    <point>Look for actual code files (.ts, .js, .sql) over documentation (.md, .txt)</point>
  </result_interpretation>

  <limitations>
    <limitation>
      <description>May miss foundational type definitions</description>
      <solution>Use Grep for "interface PluginName"</solution>
    </limitation>
    <limitation>
      <description>Shows implementations, not core contracts</description>
      <solution>Follow up with Read for full context</solution>
    </limitation>
    <limitation>
      <description>Semantic chunks may lack architectural hierarchy</description>
      <solution>Manual file exploration needed</solution>
    </limitation>
    <limitation>
      <description>Excludes filtered content: test files, generated code, config files, minified files, large data files</description>
      <solution>Use Grep tool to search test files (*.test.*, *.spec.*, __tests__, /tests/), config files, or generated content</solution>
    </limitation>
    <limitation>
      <description>For precise symbol search</description>
      <solution>Use Grep tool for exact matches</solution>
    </limitation>
  </limitations>

  <returns>Code chunks with file paths, line numbers, relevance scores, symbol information, imports, and exports</returns>
  <prerequisites>Codebase must be indexed first with index_codebase</prerequisites>
</tool>`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string'
                            },
                            codebase_path: {
                                type: 'string'
                            },
                            max_results: {
                                type: 'number',
                                default: 5
                            }
                        },
                        required: ['query', 'codebase_path']
                    }
                },
                {
                    name: 'get_indexing_status',
                    description: `<tool>
  <purpose>Check if codebases are indexed and get their status information</purpose>

  <enhanced_features>
    <feature>Shows completion statistics for finished indexing (success rates, processing time, performance metrics)</feature>
    <feature>Displays batch processing details (successful/skipped batches)</feature>
    <feature>References log files for detailed debugging</feature>
  </enhanced_features>

  <when_to_use>
    <scenario>Before indexing to check if already done</scenario>
    <scenario>After indexing to see completion statistics and success rates</scenario>
    <scenario>Debug why search returned no results</scenario>
    <scenario>Confirm indexing completed successfully</scenario>
    <scenario>Get overview of all indexed codebases</scenario>
  </when_to_use>

  <parameters>
    <parameter name="codebase_path" required="false">
      <type>string</type>
      <description>ABSOLUTE path to specific codebase to check</description>
      <examples>
        <valid>/Users/name/project</valid>
        <valid>/home/user/code/repo</valid>
        <invalid>.</invalid>
        <invalid>../project</invalid>
        <invalid>relative/path</invalid>
      </examples>
      <validation>Must be absolute path starting with / (Unix) or C:\\ (Windows)</validation>
      <optional_behavior>Omit to get status of all indexed codebases</optional_behavior>
    </parameter>
  </parameters>

  <returns>Enhanced indexing status with completion statistics when available</returns>
</tool>`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string'
                            }
                        }
                    }
                },
                {
                    name: 'clear_index',
                    description: `<tool>
  <purpose>Permanently removes all indexed data for a codebase</purpose>

  <when_to_use>
    <scenario>Clear stale data before reindexing after major code changes</scenario>
    <scenario>Remove old indexed codebases no longer needed</scenario>
    <scenario>Fix corrupted index causing search issues</scenario>
  </when_to_use>

  <parameters>
    <parameter name="codebase_path" required="false">
      <type>string</type>
      <description>ABSOLUTE path to the codebase to clear</description>
      <examples>
        <valid>/Users/name/project</valid>
        <valid>/home/user/code/repo</valid>
        <invalid>.</invalid>
        <invalid>../project</invalid>
        <invalid>relative/path</invalid>
      </examples>
      <validation>Must be absolute path starting with / (Unix) or C:\\ (Windows)</validation>
      <optional_behavior>Omit to clear ALL indexed codebases (use with caution)</optional_behavior>
    </parameter>
  </parameters>

  <warnings>
    <warning>Destructive operation. All search capabilities lost until reindexing</warning>
  </warnings>
</tool>`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            codebase_path: {
                                type: 'string'
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
                            const forceReindex = (args as any).force_reindex || false;
                            console.log(`🔍 Starting background indexing: ${(args as any).codebase_path} -> ${codebasePath}`);

                            // Spawn background process for indexing
                            const logFile = `background-indexing-${path.basename(codebasePath)}-${new Date().toISOString().replace(/:/g, '-')}.log`;

                            // Use child process to avoid MCP timeout
                            const { spawn } = await import('child_process');
                            const workerPath = path.resolve(__dirname, '..', 'background-indexing-worker.mjs');
                            const nodeProcess = spawn('node', [workerPath, codebasePath, forceReindex.toString()], {
                                detached: true,
                                stdio: ['ignore', 'pipe', 'pipe'],
                                env: {
                                    ...process.env,
                                    WILDCARD_API_KEY: process.env.WILDCARD_API_KEY,
                                    WILDCARD_API_URL: process.env.WILDCARD_API_URL
                                },
                                cwd: process.cwd()
                            });

                            // Pipe output to log file
                            const fsSync = await import('fs');
                            const logStream = fsSync.default.createWriteStream(logFile);

                            const addTimestamp = (data: Buffer) => {
                                const lines = data.toString().split('\n');
                                return lines.filter(line => line.trim()).map(line =>
                                    `[${new Date().toISOString()}] ${line}`
                                ).join('\n') + '\n';
                            };

                            nodeProcess.stdout?.on('data', (data) => {
                                const timestampedData = addTimestamp(data);
                                logStream.write(timestampedData);
                                console.log(timestampedData.trim());
                            });

                            nodeProcess.stderr?.on('data', (data) => {
                                const timestampedData = addTimestamp(data);
                                logStream.write(timestampedData);
                                console.error(timestampedData.trim());
                            });

                            nodeProcess.on('close', (code) => {
                                logStream.write(`[${new Date().toISOString()}] Process completed with code: ${code}\n`);
                                logStream.end();
                                console.log(`Background indexing process completed with code: ${code}`);
                            });

                            // Detach the process so it runs independently
                            nodeProcess.unref();

                            return {
                                content: [{
                                    type: 'text',
                                    text: `🚀 **Background Indexing Started** - Log: \`${logFile}\`

**Codebase**: ${codebasePath}
**Process**: Running in detached background mode

**📋 How to Monitor Progress:**
- **Check Status**: Use \`get_indexing_status\` tool to see completion progress
- **View Live Logs**: \`tail -f ${logFile}\`
- **Final Results**: Status tool will show success rate when complete

💡 **Tip**: The log file is saved in your current directory for easy access.

📝 **For AI Assistant**: Please mention that users can monitor progress with: tail -f ${logFile} (include the dash)`
                                }]
                            };
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

                        // Resolve relative paths to absolute paths (consistent with index_codebase)
                        const resolvedCodebasePath = (args as any).codebase_path ? path.resolve((args as any).codebase_path) : undefined;

                        // Note: Incremental indexing is automatically triggered before each search
                        const searchResult = await this.contextMcp.searchWithIntelligence(
                            (args as any).query,
                            resolvedCodebasePath,
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
                        // Resolve relative paths to absolute paths (consistent with other tools)
                        const resolvedStatusPath = (args as any).codebase_path ? path.resolve((args as any).codebase_path) : undefined;
                        const status = await this.contextMcp.getIndexingStatus(resolvedStatusPath);
                        // Use the current codebase path if none was explicitly provided
                        let codebasePathForLogs = resolvedStatusPath || status.currentCodebase?.path;

                        // If we still don't have a path, try to get it from the first indexed codebase
                        if (!codebasePathForLogs && status.indexedCodebases && status.indexedCodebases.length > 0) {
                            codebasePathForLogs = status.indexedCodebases[0].path;
                        }

                        const enhancedStatus = await this.enhanceStatusWithLogData(status, codebasePathForLogs);

                        return {
                            content: [{
                                type: 'text',
                                text: this.formatIndexingStatus(enhancedStatus)
                            }]
                        };
                    
                    case 'clear_index':
                        // Resolve relative paths to absolute paths (consistent with other tools)
                        const resolvedClearPath = (args as any).codebase_path ? path.resolve((args as any).codebase_path) : undefined;
                        const clearResult = await this.contextMcp.clearIndex(resolvedClearPath);
                        
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
                    const status = await this.contextMcp.getIndexingStatus();
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
        const wildcardUrl = process.env.WILDCARD_API_URL || 'https://deepcontext.mcp.wild-card.ai' || 'http://localhost:4000';
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
        await this.contextMcp.initialize();
        
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        
        console.error('🚀 Intelligent Context MCP Server ready!');
        console.error(`🔄 Result Reranking: ${!!(config.jinaApiKey && config.jinaApiKey !== 'test') ? '✅ Enabled' : '❌ Disabled'}`);
        console.error('📝 Local BM25 Search: ✅ Always Available');
        console.error('🔌 Transport: stdio');
    }

    /**
     * Enhance indexing status with completion statistics from log files
     */
    private async enhanceStatusWithLogData(status: any, codebasePath?: string): Promise<any> {
        const enhancedStatus = { ...status };
        
        try {
            // Find the most recent log file for this codebase
            const logFile = await this.findMostRecentLogFile(codebasePath);
            if (logFile) {
                const logStats = await this.parseLogFileStats(logFile);
                if (logStats) {
                    enhancedStatus.completionStats = logStats;
                }
            }
        } catch (error) {
            // Don't fail status check if log parsing fails
            console.warn('Failed to parse log statistics:', error);
        }
        
        return enhancedStatus;
    }

    /**
     * Find the most recent background indexing log file for a codebase
     */
    private async findMostRecentLogFile(codebasePath?: string): Promise<string | null> {
        const fs = await import('fs');
        const path = await import('path');
        
        try {
            const files = fs.readdirSync('.');
            const codebaseName = codebasePath ? path.basename(codebasePath) : '';
            
            // Find log files that match the specific codebase pattern
            const logFiles = files.filter(file => {
                if (!file.startsWith('background-indexing-') || !file.endsWith('.log')) {
                    return false;
                }

                // If no specific codebase requested, don't return any logs
                // (completion stats should only show for specific codebases)
                if (!codebaseName) {
                    return false;
                }

                // Extract the codebase name from the log file pattern:
                // background-indexing-{codebaseName}-{timestamp}.log
                // Note: codebaseName can contain hyphens, so we need to be more careful
                const match = file.match(/^background-indexing-(.+?)-(\d{4}-\d{2}-\d{2}T.+)\.log$/);
                if (!match) return false;

                const logCodebaseName = match[1];
                return logCodebaseName === codebaseName;
            });
            
            if (logFiles.length === 0) return null;
            
            // Sort by modification time (newest first)
            const sortedFiles = logFiles
                .map(file => ({
                    name: file,
                    mtime: fs.statSync(file).mtime
                }))
                .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            
            return sortedFiles[0].name;
        } catch (error) {
            return null;
        }
    }

    /**
     * Parse completion statistics from log file
     */
    private async parseLogFileStats(logFile: string): Promise<any | null> {
        const fs = await import('fs');
        
        try {
            const content = fs.readFileSync(logFile, 'utf-8');
            const lines = content.split('\n');
            
            let isCompleted = false;
            let totalChunks = 0;
            let successfulChunks = 0;
            let skippedBatches = 0;
            let totalBatches = 0;
            let processingTime = 0;
            let startTime: Date | null = null;
            let endTime: Date | null = null;
            
            // Parse log lines for statistics
            for (const line of lines) {
                // Check if process completed
                if (line.includes('Process completed with code: 0')) {
                    isCompleted = true;
                    const timeMatch = line.match(/\[([^\]]+)\]/);
                    if (timeMatch) {
                        endTime = new Date(timeMatch[1]);
                    }
                }
                
                // Extract start time
                if (line.includes('Starting indexing for:') && !startTime) {
                    const timeMatch = line.match(/\[([^\]]+)\]/);
                    if (timeMatch) {
                        startTime = new Date(timeMatch[1]);
                    }
                }
                
                // Extract upload completion stats - look for the actual completion message
                if (line.includes('✅ Uploaded') && line.includes('chunks to namespace')) {
                    // Handle the actual format: "✅ Uploaded 354 chunks to namespace: mcp_xxx"
                    const chunkMatch = line.match(/✅ Uploaded (\d+) chunks to namespace/);
                    if (chunkMatch) {
                        successfulChunks = parseInt(chunkMatch[1]);
                        totalChunks = successfulChunks; // Assume all uploaded chunks were successful
                    }
                }

                // Look for batch completion messages to count total batches
                if (line.includes('✅ Batch') && line.includes('completed successfully')) {
                    const batchMatch = line.match(/✅ Batch (\d+)\/(\d+) completed successfully/);
                    if (batchMatch) {
                        totalBatches = parseInt(batchMatch[2]);
                    }
                }
                
                // Extract processing time from JSON result
                if (line.includes('processingTimeMs')) {
                    const timeMatch = line.match(/"processingTimeMs":\s*(\d+)/);
                    if (timeMatch) {
                        processingTime = parseInt(timeMatch[1]);
                    }
                }

                // Extract chunks created from JSON result
                if (line.includes('chunksCreated')) {
                    const chunkMatch = line.match(/"chunksCreated":\s*(\d+)/);
                    if (chunkMatch) {
                        const chunks = parseInt(chunkMatch[1]);
                        if (chunks > totalChunks) {
                            totalChunks = chunks;
                            successfulChunks = chunks; // Assume all created chunks were successful
                        }
                    }
                }
            }
            
            // Only return stats if indexing is completed
            if (!isCompleted) {
                return null;
            }
            
            const successRate = totalChunks > 0 ? (successfulChunks / totalChunks * 100) : 0;
            const skippedChunks = totalChunks - successfulChunks;
            const actualProcessingTime = startTime && endTime ? 
                endTime.getTime() - startTime.getTime() : processingTime;
            
            return {
                completed: true,
                totalChunks,
                successfulChunks,
                skippedChunks,
                successRate: Math.round(successRate * 100) / 100,
                totalBatches: totalBatches || Math.ceil(totalChunks / 50), // Estimate if not found
                skippedBatches: skippedBatches || 0,
                processingTimeMs: actualProcessingTime,
                processingTimeFormatted: this.formatDuration(actualProcessingTime),
                logFile
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Format duration in milliseconds to human readable format
     */
    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
        return `${(ms / 3600000).toFixed(1)}h`;
    }

    /**
     * Format indexing status with enhanced information
     */
    private formatIndexingStatus(status: any): string {
        let result = '';
        
        // Basic status information
        result += `📊 **Indexing Status**\n\n`;
        
        if (status.currentCodebase) {
            const cb = status.currentCodebase;
            result += `**Current Codebase**: ${cb.path}\n`;
            result += `**Namespace**: ${cb.namespace}\n`;
            result += `**Files**: ${cb.fileCount}\n`;
            result += `**Last Indexed**: ${new Date(cb.lastIndexed).toLocaleString()}\n`;

            if (cb.failed) {
                result += `**Status**: ❌ Indexing Failed\n`;
                result += `**Failure Reason**: ${cb.failureReason || 'Unknown error'}\n\n`;
            } else {
                result += `**Status**: ${status.indexed ? '✅ Indexed' : '❌ Not Indexed'}\n\n`;
            }
        }
        
        // Completion statistics (only shown if indexing completed AND there's a current codebase AND stats are for this specific codebase)
        if (status.completionStats && status.currentCodebase && status.completionStats.logFile) {
            const stats = status.completionStats;
            // Verify the log file matches the current codebase name
            const currentCodebaseName = path.basename(status.currentCodebase.path);
            if (stats.logFile.includes(`background-indexing-${currentCodebaseName}-`)) {
                result += `**Success Rate**: ${stats.successRate}% (${stats.successfulChunks}/${stats.totalChunks} chunks)\n`;
                result += `**Log File**: \`${stats.logFile}\`\n\n`;
            }
        }
        
        // All indexed codebases
        if (status.indexedCodebases && status.indexedCodebases.length > 0) {
            result += `## 📚 **All Indexed Codebases** (${status.indexedCodebases.length})\n\n`;
            status.indexedCodebases.forEach((cb: any, index: number) => {
                result += `${index + 1}. **${cb.path}**\n`;

                if (cb.failed) {
                    result += `   - Status: ❌ Failed (${cb.failureReason || 'Unknown error'})\n`;
                    result += `   - Last attempt: ${new Date(cb.indexedAt).toLocaleDateString()}\n`;
                } else {
                    result += `   - Chunks: ${cb.totalChunks}, Last indexed: ${new Date(cb.indexedAt).toLocaleDateString()}\n`;

                    // Show completion stats if available for this codebase
                    if (status.completionStats && status.completionStats.logFile) {
                        const currentCodebaseName = path.basename(cb.path);
                        if (status.completionStats.logFile.includes(`background-indexing-${currentCodebaseName}-`)) {
                            const stats = status.completionStats;
                            result += `   - **Success Rate**: ${stats.successRate}% (${stats.successfulChunks}/${stats.totalChunks} chunks)\n`;
                            result += `   - **Processing Time**: ${stats.processingTimeFormatted}\n`;
                            result += `   - **Log**: \`${stats.logFile}\`\n`;
                        }
                    }
                }
                result += `\n`;
            });
        } else {
            result += `## 📚 **No Indexed Codebases Found**\n\n`;
            result += `Use the \`index_codebase\` tool to index a codebase first.\n`;
        }
        
        return result;
    }
}

// Always run when executed as a CLI
const main = async () => {
    const server = new StandaloneMCPServer();
    await server.run();
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
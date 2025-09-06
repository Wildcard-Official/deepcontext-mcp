/**
 * Integration layer that combines the new core architecture 
 * with the working standalone MCP implementation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// Core components
import { IndexingOrchestrator } from './core/indexing/IndexingOrchestrator.js';
import { IncrementalIndexer } from './core/indexing/IncrementalIndexer.js';
import { FileUtils } from './utils/FileUtils.js';
import { Logger } from './utils/Logger.js';
import { HybridSearchService, TurbopufferStore } from './services/HybridSearchService.js';

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
}

interface IndexedCodebase {
    path: string;
    namespace: string;
    totalChunks: number;
    indexedAt: string;
}

interface StandaloneConfig {
    jinaApiKey: string;
    turbopufferApiKey: string;
    openaiApiKey?: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class StandaloneCodexMcp {
    private config: StandaloneConfig;
    private indexingOrchestrator: IndexingOrchestrator;
    private incrementalIndexer: IncrementalIndexer;
    private fileUtils: FileUtils;
    private logger: Logger;
    private turbopufferStore: TurbopufferStore;
    private hybridSearchService: HybridSearchService;
    
    // Vector store integration
    private turbopufferApiUrl = 'https://gcp-us-central1.turbopuffer.com/v2';
    private jinaApiUrl = 'https://api.jina.ai/v1/embeddings';
    
    // State management
    private indexedCodebases: Map<string, IndexedCodebase> = new Map();

    constructor(config?: Partial<StandaloneConfig>) {
        this.config = {
            jinaApiKey: config?.jinaApiKey || process.env.JINA_API_KEY || 'test',
            turbopufferApiKey: config?.turbopufferApiKey || process.env.TURBOPUFFER_API_KEY || 'test',
            openaiApiKey: config?.openaiApiKey || process.env.OPENAI_API_KEY,
            logLevel: config?.logLevel || 'info'
        };
        
        this.logger = new Logger('STANDALONE-INTEGRATION', this.config.logLevel);
        this.fileUtils = new FileUtils();
        this.indexingOrchestrator = new IndexingOrchestrator();
        this.incrementalIndexer = new IncrementalIndexer();
        // Create Turbopuffer store integration
        this.turbopufferStore = {
            search: async (namespace: string, options: any) => {
                return await this.turbopufferQuery(namespace, options);
            },
            hybridSearch: async (namespace: string, options: any) => {
                return await this.performHybridSearch(namespace, options);
            }
        };
        
        // Create embedding integration for hybrid search
        const embedding = this.createEmbeddingIntegration();
        
        // Initialize hybrid search service using Turbopuffer's native capabilities
        this.hybridSearchService = new HybridSearchService(
            this.turbopufferStore,
            embedding
        );
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
        const startTime = Date.now();
        
        try {
            this.logger.info(`Starting intelligent indexing for: ${codebasePath}`);
            
            // Use new architecture for indexing
            const indexingRequest: IndexingRequest = {
                codebasePath,
                force: forceReindex,
                enableContentFiltering: true,
                enableDependencyAnalysis: true,
                enableIncrementalUpdate: !forceReindex
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
            
            // Store indexing metadata
            const normalizedPath = path.resolve(codebasePath);
            const indexedCodebase: IndexedCodebase = {
                path: normalizedPath,
                namespace: result.metadata.namespace,
                totalChunks: result.chunks.length,
                indexedAt: new Date().toISOString()
            };
            
            this.indexedCodebases.set(normalizedPath, indexedCodebase);
            await this.saveIndexedCodebases();

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
        
        const namespace = this.generateNamespace(codebasePath);
        
        try {
            this.logger.info(`🔍 Hybrid search: "${query}" in ${codebasePath}`);

            // Use direct Turbopuffer hybrid search with queries array approach
            this.logger.debug('Generating embedding for hybrid search...');
            const embedding = await this.generateEmbedding(query);
            this.logger.info(`Embedding generated: ${embedding.length} dimensions`);

            this.logger.info('Calling Turbopuffer hybrid search...');
            const rawResults = await this.turbopufferStore.hybridSearch(namespace, {
                embedding,
                query,
                limit: options.limit || 10,
                vectorWeight: options.vectorWeight || 0.7,
                bm25Weight: options.bm25Weight || 0.3
            });

            this.logger.info(`Raw results received: ${rawResults.length}`);

            // Convert results to expected format
            const results = rawResults.map((result: any) => ({
                id: result.id,
                score: result.score,
                content: result.metadata.content,
                filePath: result.metadata.filePath,
                startLine: result.metadata.startLine,
                endLine: result.metadata.endLine,
                symbols: result.metadata.symbols ? result.metadata.symbols.split(',').filter(Boolean) : [],
                language: result.metadata.language,
                similarity: result.score
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

            const namespace = this.generateNamespace(codebasePath);
            const limit = options.limit || 10;

            // Direct BM25 search through Turbopuffer
            const response = await fetch(`https://gcp-us-central1.turbopuffer.com/v2/namespaces/${namespace}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.turbopufferApiKey}`
                },
                body: JSON.stringify({
                    rank_by: ['content', 'BM25', query],
                    top_k: options.enableReranking ? limit * 2 : limit,
                    include_attributes: ['content', 'symbols', 'filePath', 'startLine', 'endLine', 'language']
                })
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Turbopuffer BM25 search failed: ${response.status} ${error}`);
            }

            const data = await response.json();
            const rawResults = (data.rows || []).map((item: any) => ({
                id: item.id,
                score: Math.max(0, parseFloat(item.$dist) || 0),
                content: item.content || '',
                symbols: item.symbols ? item.symbols.split(',').filter(Boolean) : [],
                filePath: item.filePath || '',
                startLine: item.startLine || 0,
                endLine: item.endLine || 0,
                language: item.language || ''
            }));

            let results = rawResults;

            // Apply reranking if enabled
            if (options.enableReranking && rawResults.length > 0 && this.config.jinaApiKey) {
                try {
                    this.logger.debug('Applying Jina reranking to BM25 results...');
                    const documents = rawResults.map((r: any) => r.content);
                    const rerankedIndices = await this.rerank(query, documents, limit);
                    
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
            }

            // Use hybrid search service
            const searchResult = await this.searchHybrid(codebasePath || '', query, {
                limit: maxResults,
                enableQueryEnhancement: true,
                enableReranking: true
            });
            
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
                score: result.score
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
            currentCodebase = this.indexedCodebases.get(codebasePath);
            if (currentCodebase) {
                try {
                    incrementalStats = await this.incrementalIndexer.getIndexStats(codebasePath);
                } catch (error) {
                    this.logger.warn('Could not get incremental stats:', error);
                }
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
                    
                    // Clear incremental metadata
                    await this.incrementalIndexer.forceFullReindex(codebasePath);
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
                return await this.generateEmbedding(text);
            },
            embedBatch: async (texts: string[]) => {
                return await this.generateEmbeddingBatch(texts);
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
            const embeddings = await this.generateEmbeddingBatch(
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
                symbols: chunk.symbols.join(','),
                codebasePath: this.resolveCodebasePath(chunk.filePath)
            }));
            
            // Upload to Turbopuffer
            await this.turbopufferUpsert(namespace, upsertData);
            
            
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

    private generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 8)}`;
    }

    private async vectorStoreSearch(query: string, namespace: string, limit: number): Promise<any[]> {
        const queryEmbedding = await this.generateEmbedding(query);
        return await this.turbopufferQuery(namespace, { embedding: queryEmbedding, limit });
    }

    private async vectorStoreSymbolSearch(symbols: string[], namespace: string, limit: number): Promise<any[]> {
        const symbolQuery = symbols.join(' ');
        return await this.vectorStoreSearch(symbolQuery, namespace, limit);
    }

    private async checkNamespaceExists(namespace: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
                headers: { 'Authorization': `Bearer ${this.config.turbopufferApiKey}` }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // Jina AI integration
    private async rerank(query: string, documents: string[], topN?: number): Promise<Array<{ index: number; relevance_score: number }>> {
        const response = await fetch('https://api.jina.ai/v1/rerank', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.jinaApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'jina-reranker-v2-base-multilingual',
                query,
                documents,
                top_n: topN || documents.length,
                return_documents: false
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jina Reranker API error: ${response.status} ${error}`);
        }

        const data = await response.json();
        return data.results;
    }

    private async generateEmbedding(text: string): Promise<number[]> {
        if (!text || text.trim().length === 0) {
            throw new Error('Cannot generate embedding for empty text');
        }
        
        const response = await fetch(this.jinaApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.jinaApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: [text],
                model: 'jina-embeddings-v3',
                dimensions: 1024
            })
        });
        
        if (!response.ok) {
            throw new Error(`Jina API error: ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.data[0].embedding;
    }

    private async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        
        const response = await fetch(this.jinaApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.jinaApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: texts,
                model: 'jina-embeddings-v3',
                dimensions: 1024
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jina API batch error (${response.status}): ${error}`);
        }
        
        const data = await response.json();
        return data.data.map((item: any) => item.embedding);
    }

    // Turbopuffer integration
    private async turbopufferUpsert(namespace: string, vectors: any[]): Promise<void> {
        const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.turbopufferApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                upsert_rows: vectors,
                distance_metric: 'cosine_distance',
                schema: {
                    content: {
                        type: 'string',
                        full_text_search: true
                    }
                }
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Turbopuffer upsert error (${response.status}): ${error}`);
        }
    }

    private async turbopufferQuery(namespace: string, options: any): Promise<any[]> {
        const requestBody: any = {
            include_attributes: ['content', 'filePath', 'relativePath', 'startLine', 'endLine', 'language', 'symbols'],
            top_k: options.limit || 10
        };

        // Handle different search types based on options
        if (options.rank_by) {
            // Direct rank_by specification (for hybrid search)
            requestBody.rank_by = options.rank_by;
        } else if (options.embedding) {
            // Vector search
            requestBody.rank_by = ['vector', 'ANN', options.embedding];
        } else if (options.query) {
            // BM25 text search
            requestBody.rank_by = [`content BM25 "${options.query}"`];
        }

        // Add filters if provided
        if (options.filters) {
            requestBody.filters = options.filters;
        }

        const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.turbopufferApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Turbopuffer query error: ${error}`);
        }
        
        const data = await response.json();
        return (data.rows || []).map((row: any) => ({
            id: row.id,
            score: row.score || row._distance || row.$dist || 0,
            metadata: row.attributes || row
        }));
    }


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
        const limit = options.limit || 10;
        const vectorWeight = options.vectorWeight || 0.7;
        const bm25Weight = options.bm25Weight || 0.3;
        
        // Use Turbopuffer's queries array format (same as backend implementation)
        const response = await fetch(`https://gcp-us-central1.turbopuffer.com/v2/namespaces/${namespace}/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.turbopufferApiKey}`
            },
            body: JSON.stringify({
                queries: [
                    // Vector search query
                    {
                        rank_by: ['vector', 'ANN', options.embedding],
                        top_k: Math.min(limit * 2, 50),
                        include_attributes: [
                            'content', 'symbols', 'filePath', 'startLine', 'endLine', 
                            'language'
                        ]
                    },
                    // BM25 search query
                    {
                        rank_by: ['content', 'BM25', options.query],
                        top_k: Math.min(limit * 2, 50),
                        include_attributes: [
                            'content', 'symbols', 'filePath', 'startLine', 'endLine', 
                            'language'
                        ]
                    }
                ]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Turbopuffer hybrid search failed: ${response.status} ${error}`);
        }

        const data = await response.json();
        
        // Use the same fusion logic as backend
        return this.fuseHybridResults(data, limit, { vectorWeight, bm25Weight });
    }

    /**
     * Fuse hybrid search results using backend's proven logic
     */
    private fuseHybridResults(
        multiQueryResults: any,
        limit: number,
        weights: { vectorWeight: number; bm25Weight: number }
    ): any[] {
        const scores = new Map<string, number>();
        const metadata = new Map<string, any>();
        
        // Extract results from Turbopuffer response: { results: [{ rows: [...] }, { rows: [...] }] }
        const vectorResults = multiQueryResults.results?.[0]?.rows || [];
        const bm25Results = multiQueryResults.results?.[1]?.rows || [];
        
        this.logger.info(`Hybrid search - Vector: ${vectorResults.length}, BM25: ${bm25Results.length}`);
        
        // Process vector search results (first query)
        vectorResults.forEach((item: any, rank: number) => {
            const reciprocalRank = weights.vectorWeight / (rank + 1);
            scores.set(item.id, (scores.get(item.id) || 0) + reciprocalRank);
            
            if (!metadata.has(item.id)) {
                metadata.set(item.id, {
                    content: item.content || '',
                    symbols: item.symbols || '',
                    filePath: item.filePath || '',
                    startLine: item.startLine || 0,
                    endLine: item.endLine || 0,
                    language: item.language || ''
                });
            }
        });
        
        // Process BM25 search results (second query)
        bm25Results.forEach((item: any, rank: number) => {
            const reciprocalRank = weights.bm25Weight / (rank + 1);
            scores.set(item.id, (scores.get(item.id) || 0) + reciprocalRank);
            
            if (!metadata.has(item.id)) {
                metadata.set(item.id, {
                    content: item.content || '',
                    symbols: item.symbols || '',
                    filePath: item.filePath || '',
                    startLine: item.startLine || 0,
                    endLine: item.endLine || 0,
                    language: item.language || ''
                });
            }
        });
        
        const finalResults = Array.from(scores.entries())
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
            .map(([id, score]) => ({
                id,
                score,
                metadata: metadata.get(id)
            }));
        
        this.logger.info(`Fusion completed - Final: ${finalResults.length} results`);
        
        return finalResults;
    }

    /**
     * Reciprocal Rank Fusion (RRF) for combining search results
     */
    private fuseSearchResults(
        results: any[], 
        k: number = 60,
        vectorWeight: number = 0.7,
        bm25Weight: number = 0.3
    ): any[] {
        // Group results by ID and calculate RRF scores
        const resultMap = new Map<string, any>();
        
        // Separate results by query type
        const vectorResults = results.filter(r => r.queryType === 'vector');
        const bm25Results = results.filter(r => r.queryType === 'bm25');
        
        // Calculate ranks for each query type
        vectorResults.forEach((result, index) => {
            const rrf = vectorWeight / (k + index + 1);
            if (resultMap.has(result.id)) {
                resultMap.get(result.id).fusedScore += rrf;
            } else {
                resultMap.set(result.id, {
                    ...result,
                    fusedScore: rrf,
                    vectorRank: index + 1,
                    bm25Rank: null
                });
            }
        });
        
        bm25Results.forEach((result, index) => {
            const rrf = bm25Weight / (k + index + 1);
            if (resultMap.has(result.id)) {
                resultMap.get(result.id).fusedScore += rrf;
                resultMap.get(result.id).bm25Rank = index + 1;
            } else {
                resultMap.set(result.id, {
                    ...result,
                    fusedScore: rrf,
                    vectorRank: null,
                    bm25Rank: index + 1
                });
            }
        });
        
        // Sort by fused score and return
        return Array.from(resultMap.values())
            .sort((a, b) => b.fusedScore - a.fusedScore)
            .map(result => ({
                id: result.id,
                score: result.fusedScore,
                metadata: result.metadata,
                vectorRank: result.vectorRank,
                bm25Rank: result.bm25Rank
            }));
    }

    private async clearVectorStoreNamespace(namespace: string): Promise<void> {
        try {
            const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.config.turbopufferApiKey}`
                }
            });
            
            if (response.ok) {
                this.logger.info(`✅ Cleared namespace: ${namespace}`);
            }
        } catch (error) {
            this.logger.warn(`Failed to clear namespace ${namespace}:`, error);
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
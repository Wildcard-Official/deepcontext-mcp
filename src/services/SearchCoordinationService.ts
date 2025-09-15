/**
 * Search Coordination Service
 * Orchestrates all types of search operations including hybrid, BM25, vector, and intelligent search
 */

import { Logger } from '../utils/Logger.js';
import { JinaApiService } from './JinaApiService.js';
import { TurbopufferService } from './TurbopufferService.js';

export interface SearchOptions {
    limit?: number;
    vectorWeight?: number;
    bm25Weight?: number;
    fileTypes?: string[];
    offset?: number;
    enableQueryEnhancement?: boolean;
    enableReranking?: boolean;
}

export interface SearchResult {
    id: string;
    score: number;
    content: string;
    filePath: string;
    startLine: number;
    endLine: number;
    symbols: string[];
    language: string;
    similarity?: number;
    connections?: {
        imports: string[];
        exports: string[];
        relatedFiles: string[];
    };
}

export interface SearchResponse {
    success: boolean;
    results: SearchResult[];
    searchTime: number;
    strategy: string;
    metadata?: {
        vectorResults?: number;
        bm25Results?: number;
        totalMatches?: number;
        queryEnhanced?: boolean;
        reranked?: boolean;
    };
}

export interface IntelligentSearchResponse {
    success: boolean;
    results: any[];
    totalResults: number;
    searchTimeMs: number;
    message: string;
}


export class SearchCoordinationService {
    private logger: Logger;

    constructor(
        private jinaApiService: JinaApiService,
        private turbopufferService: TurbopufferService,
        private connectionExtractor: (filePath: string, content: string) => Promise<any>,
        loggerName: string = 'SearchCoordinationService'
    ) {
        this.logger = new Logger(loggerName);
    }

    /**
     * Advanced hybrid search combining vector similarity and BM25 full-text search
     */
    async searchHybrid(
        namespace: string,
        query: string,
        options: SearchOptions = {}
    ): Promise<SearchResponse> {
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
        
        try {
            this.logger.info(`🔍 Hybrid search: "${query}" in namespace: ${namespace}`);

            // Generate embedding for hybrid search
            this.logger.debug('Generating embedding for hybrid search...');
            const embedding = await this.jinaApiService.generateEmbedding(query);
            this.logger.info(`Embedding generated: ${embedding.length} dimensions`);

            // Use Turbopuffer hybrid search
            this.logger.info('Calling Turbopuffer hybrid search...');
            const rawResults = await this.turbopufferService.hybridSearch(namespace, {
                embedding,
                query,
                limit: options.limit || 10,
                vectorWeight: options.vectorWeight || 0.1,
                bm25Weight: options.bm25Weight || 0.9
            });

            this.logger.info(`Raw results received: ${rawResults.length}`);

            // Convert results to expected format with connection context
            const results = await Promise.all(rawResults.map(async (result: any) => {
                let content = result.metadata.content;
                
                // Add connection context for better architecture understanding
                const connections = await this.connectionExtractor(
                    result.metadata.filePath,
                    content
                );
                
                return {
                    id: result.id,
                    score: result.score,
                    content: content,
                    filePath: result.metadata.filePath,
                    startLine: result.metadata.startLine,
                    endLine: result.metadata.endLine,
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
    async searchBM25(
        namespace: string,
        query: string,
        options: SearchOptions = {}
    ): Promise<SearchResponse> {
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
            this.logger.info(`📝 BM25 search: "${query}" in namespace: ${namespace}`);

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
                    this.logger.warn('Reranking failed, using original BM25 scores', { 
                        error: error instanceof Error ? error.message : String(error) 
                    });
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
            this.logger.error('BM25 search failed', { 
                error: error instanceof Error ? error.message : String(error), 
                query: query.substring(0, 50) 
            });
            return {
                success: false,
                results: [],
                searchTime: Date.now() - startTime,
                strategy: 'bm25'
            };
        }
    }

    /**
     * Vector similarity search
     */
    async searchVector(
        namespace: string,
        query: string,
        limit: number = 10
    ): Promise<any[]> {
        const queryEmbedding = await this.jinaApiService.generateEmbedding(query);
        return await this.turbopufferService.query(namespace, { 
            embedding: queryEmbedding, 
            limit 
        });
    }

    /**
     * Symbol-based vector search
     */
    async searchVectorBySymbols(
        namespace: string,
        symbols: string[],
        limit: number = 10
    ): Promise<any[]> {
        const symbolQuery = symbols.join(' ');
        return await this.searchVector(namespace, symbolQuery, limit);
    }

    /**
     * Intelligent search with automatic namespace detection
     */
    async searchWithIntelligence(
        query: string,
        codebasePath: string | undefined,
        indexedCodebases: Map<string, any>,
        maxResults: number = 10
    ): Promise<IntelligentSearchResponse> {
        const startTime = Date.now();
        
        try {
            // Determine namespace from codebase path or use first available
            let namespace: string;
            let actualCodebasePath: string;
            
            if (codebasePath) {
                // Normalize path for comparison
                const path = await import('path');
                const normalizedPath = path.resolve(codebasePath);
                const indexed = indexedCodebases.get(normalizedPath);
                if (!indexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: `Codebase not found or not indexed: ${codebasePath}`
                    };
                }
                namespace = indexed.namespace;
                actualCodebasePath = normalizedPath;
            } else {
                // Use first available indexed codebase
                const firstIndexed = Array.from(indexedCodebases.values())[0];
                if (!firstIndexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: 'No indexed codebases available'
                    };
                }
                namespace = firstIndexed.namespace;
                actualCodebasePath = firstIndexed.path;
            }

            this.logger.info(`🔍 Intelligent search for: "${query}" in ${actualCodebasePath}`);

            // Use hybrid search as the intelligent search strategy
            const searchResult = await this.searchHybrid(namespace, query, {
                limit: maxResults,
                vectorWeight: 0.6,
                bm25Weight: 0.4
            });
            
            // Apply Jina reranker v2 if API key is available and we have results
            if (searchResult.success && searchResult.results.length > 0 && this.jinaApiService.isAvailable()) {
                try {
                    const rerankedResults = await this.jinaApiService.rerankerResults(query, searchResult.results);
                    if (rerankedResults && rerankedResults.length > 0) {
                        searchResult.results = rerankedResults;
                        this.logger.info(`🎯 Results reranked using Jina v2: ${rerankedResults.length} results`);
                    }
                } catch (error) {
                    this.logger.warn('Reranking with Jina failed, using hybrid results', { 
                        error: error instanceof Error ? error.message : String(error) 
                    });
                }
            }

            const searchTimeMs = Date.now() - startTime;
            
            if (searchResult.success && searchResult.results.length > 0) {
                this.logger.info(`✅ Search completed: ${searchResult.results.length} results in ${searchTimeMs}ms`);
                return {
                    success: true,
                    results: searchResult.results,
                    totalResults: searchResult.results.length,
                    searchTimeMs,
                    message: `Found ${searchResult.results.length} relevant code chunks`
                };
            } else {
                return {
                    success: true,
                    results: [],
                    totalResults: 0,
                    searchTimeMs,
                    message: 'No relevant code chunks found for the query'
                };
            }

        } catch (error) {
            this.logger.error('Intelligent search failed', { 
                error: error instanceof Error ? error.message : String(error), 
                query: query.substring(0, 50) 
            });
            
            return {
                success: false,
                results: [],
                totalResults: 0,
                searchTimeMs: Date.now() - startTime,
                message: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Check if search services are available
     */
    isAvailable(): boolean {
        return this.jinaApiService.isAvailable() && this.turbopufferService.isAvailable();
    }

    /**
     * Get search service status
     */
    getStatus(): {
        jinaAvailable: boolean;
        turbopufferAvailable: boolean;
        overallAvailable: boolean;
    } {
        const jinaAvailable = this.jinaApiService.isAvailable();
        const turbopufferAvailable = this.turbopufferService.isAvailable();
        
        return {
            jinaAvailable,
            turbopufferAvailable,
            overallAvailable: jinaAvailable && turbopufferAvailable
        };
    }
}
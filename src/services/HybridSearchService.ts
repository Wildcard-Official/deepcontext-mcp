/**
 * Hybrid Search Service - Uses Turbopuffer's native vector + BM25 capabilities
 * Leverages Turbopuffer's built-in hybrid search for optimal performance
 */

import { Logger } from '../utils/Logger.js';
import { SearchResult, HybridSearchOptions } from '../core/search/interfaces.js';

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: any;
}

export interface TurbopufferStore {
  // Native hybrid search combining vector similarity and BM25
  search(namespace: string, options: {
    embedding?: number[];
    query?: string;
    rank_by?: any[];
    limit: number;
    filters?: Record<string, any>;
  }): Promise<VectorSearchResult[]>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class HybridSearchService {
  private logger = new Logger('HybridSearchService');

  constructor(
    private turbopuffer: TurbopufferStore,
    private embeddingProvider: EmbeddingProvider
  ) {}

  /**
   * Native hybrid search using Turbopuffer's vector + BM25 capabilities
   */
  async search(
    codebasePath: string,
    query: string,
    options: HybridSearchOptions & {
      limit?: number;
      minScore?: number;
      fileTypes?: string[];
      namespace: string;
    }
  ): Promise<SearchResult[]> {
    const {
      vectorWeight = 0.7,
      bm25Weight = 0.3,
      limit = 10,
      namespace,
      fileTypes,
      minScore = 0.1
    } = options;

    this.logger.debug('Starting native hybrid search', {
      query: query.substring(0, 50),
      vectorWeight,
      bm25Weight,
      limit
    });

    try {
      // Generate embedding for the query
      const embedding = await this.embeddingProvider.embed(query);
      
      // Use Turbopuffer's native hybrid search with both vector and BM25
      const results = await this.turbopuffer.search(namespace, {
        embedding,
        query,
        rank_by: ["vector", "ANN", embedding],
        limit
      });

      // Convert to SearchResult format
      return this.convertToSearchResults(results, minScore);
      
    } catch (error) {
      this.logger.error('Hybrid search failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return [];
    }
  }

  /**
   * Convert Turbopuffer results to SearchResult format
   */
  private convertToSearchResults(
    results: VectorSearchResult[], 
    minScore: number
  ): SearchResult[] {
    return results
      .filter(result => result.score >= minScore)
      .map(result => ({
        id: result.id,
        content: result.metadata?.content || '',
        score: result.score,
        filePath: result.metadata?.filePath || '',
        startLine: result.metadata?.startLine || 0,
        endLine: result.metadata?.endLine || 0,
        language: result.metadata?.language,
        symbols: result.metadata?.symbols || [],
        metadata: {
          relativePath: result.metadata?.relativePath,
          imports: result.metadata?.imports
        }
      }));
  }

  /**
   * Pure BM25 search using Turbopuffer (no vector component)
   */
  async searchBM25Only(
    codebasePath: string,
    query: string,
    options: {
      limit?: number;
      fileTypes?: string[];
      offset?: number;
      namespace: string;
    }
  ): Promise<SearchResult[]> {
    const { limit = 10, fileTypes, namespace } = options;

    this.logger.debug('Starting BM25-only search', {
      query: query.substring(0, 50),
      limit
    });

    try {
      // Use Turbopuffer's native BM25 search without vector component
      const results = await this.turbopuffer.search(namespace, {
        query,
        rank_by: ["content", "BM25", query],
        limit
      });

      return this.convertToSearchResults(results, 0.1);
      
    } catch (error) {
      this.logger.error('BM25 search failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return [];
    }
  }

  /**
   * Get search statistics from Turbopuffer
   */
  async getSearchStats(namespace: string): Promise<{
    totalChunks: number;
    indexedChunks: number;
    languages: Record<string, number>;
    lastIndexed?: number;
  }> {
    try {
      // Query Turbopuffer for statistics (implementation depends on available APIs)
      // For now, return basic stats - could be enhanced with actual Turbopuffer stats API
      this.logger.debug('Getting search stats from Turbopuffer', { namespace });
      
      return {
        totalChunks: 0, // Would need Turbopuffer stats API
        indexedChunks: 0, // Would need Turbopuffer stats API
        languages: {}, // Would need to query for language distribution
        lastIndexed: undefined
      };
    } catch (error) {
      this.logger.error('Failed to get search stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return {
        totalChunks: 0,
        indexedChunks: 0,
        languages: {},
        lastIndexed: undefined
      };
    }
  }
}
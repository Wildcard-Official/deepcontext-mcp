/**
 * Hybrid Search Service - Combines Turbopuffer vectors with local SQLite BM25
 * Best of both worlds: semantic similarity + exact keyword matching
 */

import { Logger } from '../utils/Logger.js';
import { LocalMetadataStore, FTSResult } from '../storage/LocalMetadataStore.js';
import { SearchResult, HybridSearchOptions } from '../core/search/interfaces.js';

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: any;
}

export interface VectorStore {
  search(namespace: string, options: {
    embedding: number[];
    limit: number;
    minScore?: number;
    fileTypes?: string[];
  }): Promise<VectorSearchResult[]>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class HybridSearchService {
  private logger = new Logger('HybridSearchService');

  constructor(
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider,
    private metadataStore: LocalMetadataStore
  ) {}

  /**
   * Hybrid search combining vector similarity and BM25 text search
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

    this.logger.debug('Starting hybrid search', {
      query: query.substring(0, 50),
      vectorWeight,
      bm25Weight,
      limit
    });

    // Execute both searches in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      this.performVectorSearch(namespace, query, limit * 2, fileTypes, minScore),
      this.performBM25Search(codebasePath, query, limit * 2, fileTypes)
    ]);

    this.logger.debug('Search results obtained', {
      vectorCount: vectorResults.length,
      bm25Count: bm25Results.length
    });

    // Combine results using reciprocal rank fusion
    const fusedResults = await this.fuseResults(
      vectorResults,
      bm25Results,
      { vectorWeight, bm25Weight },
      limit
    );

    this.logger.debug('Fusion completed', {
      fusedCount: fusedResults.length
    });

    return fusedResults;
  }

  /**
   * Vector similarity search via Turbopuffer
   */
  private async performVectorSearch(
    namespace: string,
    query: string,
    limit: number,
    fileTypes?: string[],
    minScore?: number
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      const embedding = await this.embeddingProvider.embed(query);
      
      const results = await this.vectorStore.search(namespace, {
        embedding,
        limit,
        minScore,
        fileTypes
      });

      return results.map(result => ({
        id: result.id,
        score: result.score
      }));
    } catch (error) {
      this.logger.warn('Vector search failed', { error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  /**
   * BM25 full-text search via local SQLite
   */
  private async performBM25Search(
    codebasePath: string,
    query: string,
    limit: number,
    fileTypes?: string[]
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      const results = await this.metadataStore.searchFullText(codebasePath, query, {
        limit,
        fileTypes
      });

      return results.map(result => ({
        id: result.id,
        score: Math.max(0, result.score) // Ensure positive scores
      }));
    } catch (error) {
      this.logger.warn('BM25 search failed', { error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion to combine vector and BM25 results
   */
  private async fuseResults(
    vectorResults: Array<{ id: string; score: number }>,
    bm25Results: Array<{ id: string; score: number }>,
    weights: { vectorWeight: number; bm25Weight: number },
    limit: number
  ): Promise<SearchResult[]> {
    const scores = new Map<string, number>();
    const allIds = new Set<string>();

    // Process vector search results
    vectorResults.forEach((result, rank) => {
      const reciprocalRank = weights.vectorWeight / (rank + 1);
      scores.set(result.id, (scores.get(result.id) || 0) + reciprocalRank);
      allIds.add(result.id);
    });

    // Process BM25 search results
    bm25Results.forEach((result, rank) => {
      const reciprocalRank = weights.bm25Weight / (rank + 1);
      scores.set(result.id, (scores.get(result.id) || 0) + reciprocalRank);
      allIds.add(result.id);
    });

    // Get metadata for all results
    return await this.enrichWithMetadata(Array.from(allIds), scores, limit);
  }

  /**
   * Enrich results with metadata from local store
   */
  private async enrichWithMetadata(
    ids: string[],
    scores: Map<string, number>,
    limit: number
  ): Promise<SearchResult[]> {
    if (ids.length === 0) {
      return [];
    }

    try {
      const metadataMap = await this.metadataStore.getChunksByIds(ids);
      
      const results: SearchResult[] = [];

      for (const id of ids) {
        const metadata = metadataMap.get(id);
        const score = scores.get(id) || 0;

        if (metadata && score > 0) {
          results.push({
            id,
            content: metadata.content,
            score,
            filePath: metadata.filePath,
            startLine: metadata.startLine,
            endLine: metadata.endLine,
            language: metadata.language,
            symbols: metadata.symbols,
            metadata: {
              relativePath: metadata.relativePath,
              imports: metadata.imports,
              dependencies: metadata.dependencies
            }
          });
        }
      }

      // Sort by score and limit results
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    } catch (error) {
      this.logger.error('Failed to enrich results with metadata', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        idsCount: ids.length
      });
      return [];
    }
  }

  /**
   * Pure BM25 search (no vector component)
   */
  async searchBM25Only(
    codebasePath: string,
    query: string,
    options: {
      limit?: number;
      fileTypes?: string[];
      offset?: number;
    } = {}
  ): Promise<SearchResult[]> {
    const results = await this.metadataStore.searchFullText(codebasePath, query, {
      limit: options.limit || 10,
      fileTypes: options.fileTypes,
      offset: options.offset
    });

    return results.map(result => ({
      id: result.id,
      content: result.metadata.content,
      score: Math.max(0, result.score),
      filePath: result.metadata.filePath,
      startLine: result.metadata.startLine,
      endLine: result.metadata.endLine,
      language: result.metadata.language,
      symbols: result.metadata.symbols,
      metadata: {
        relativePath: result.metadata.relativePath,
        imports: result.metadata.imports,
        dependencies: result.metadata.dependencies
      }
    }));
  }

  /**
   * Get search statistics
   */
  async getSearchStats(codebasePath: string): Promise<{
    totalChunks: number;
    indexedChunks: number;
    languages: Record<string, number>;
    lastIndexed?: number;
  }> {
    return this.metadataStore.getCodebaseStats(codebasePath);
  }
}
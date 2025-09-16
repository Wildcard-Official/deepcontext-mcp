/**
 * Search-related type definitions
 * Extracted from HybridSearchService for reuse
 */

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

  // True hybrid search using RRF fusion
  hybridSearch(namespace: string, options: {
    embedding: number[];
    query: string;
    limit?: number;
    vectorWeight?: number;
    bm25Weight?: number;
    filters?: Record<string, any>;
  }): Promise<VectorSearchResult[]>;
}
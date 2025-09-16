/**
 * Result Reranker - Standalone Implementation  
 * Uses JinaApiService to improve search result relevance
 */

import { Logger } from '../utils/Logger.js';
import { SearchResult } from '../core/search/interfaces.js';
import { JinaApiService } from './JinaApiService.js';

export interface RerankerResult {
  index: number;
  relevance_score: number;
  document: {
    text: string;
  };
}

export interface RerankerResponse {
  results: RerankerResult[];
  usage: {
    total_tokens: number;
    prompt_tokens: number;
  };
}

export interface RerankingOptions {
  topN?: number;
  model?: string;
  returnDocuments?: boolean;
}

export class ResultReranker {
  private logger = new Logger('ResultReranker');
  private jinaApiService: JinaApiService;

  constructor(jinaApiKey: string) {
    if (!jinaApiKey) {
      throw new Error('Jina API key is required for reranking');
    }
    this.jinaApiService = new JinaApiService(jinaApiKey);
  }

  /**
   * Rerank search results using JinaApiService
   */
  async rerank(
    query: string,
    results: SearchResult[],
    options: RerankingOptions = {}
  ): Promise<SearchResult[]> {
    if (!results.length) {
      return results;
    }

    try {
      // Use JinaApiService rerankerResults method which handles the full pipeline
      const rerankedResults = await this.jinaApiService.rerankerResults(query, results);
      
      return rerankedResults;
    } catch (error) {
      this.logger.warn('Reranking failed, returning original results', {
        error: error instanceof Error ? error.message : 'Unknown error',
        resultsCount: results.length
      });
      return results;
    }
  }


  /**
   * Check if reranking is available (API key provided)
   */
  isAvailable(): boolean {
    return this.jinaApiService.isAvailable();
  }

  /**
   * Get the model name for logging/debugging
   */
  getModelName(): string {
    return this.jinaApiService.getRerankerModel();
  }
}
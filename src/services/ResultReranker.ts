/**
 * Result Reranker - Standalone Implementation  
 * Uses Jina's reranker API to improve search result relevance
 */

import { Logger } from '../utils/Logger.js';
import { SearchResult } from '../core/search/interfaces.js';

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
  private readonly baseUrl = 'https://api.jina.ai/v1';
  private readonly defaultModel = 'jina-reranker-v2-base-multilingual';

  constructor(private jinaApiKey: string) {
    if (!jinaApiKey) {
      throw new Error('Jina API key is required for reranking');
    }
  }

  /**
   * Rerank search results using Jina's reranker API
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
      // Prepare documents for reranking - use content or symbol information
      const documents = results.map(result => 
        this.extractRelevantText(result)
      );

      const response = await this.callRerankerAPI(query, documents, options);
      
      // Map reranked results back to original SearchResult format
      return this.mapRerankedResults(results, response.results);
    } catch (error) {
      this.logger.warn('Reranking failed, returning original results', {
        error: error instanceof Error ? error.message : 'Unknown error',
        resultsCount: results.length
      });
      return results;
    }
  }

  private async callRerankerAPI(
    query: string,
    documents: string[],
    options: RerankingOptions
  ): Promise<RerankerResponse> {
    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.jinaApiKey}`
      },
      body: JSON.stringify({
        model: options.model || this.defaultModel,
        query: query,
        documents: documents,
        top_n: options.topN || documents.length,
        return_documents: options.returnDocuments !== false
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jina Reranker API error: ${response.status} ${response.statusText}. Details: ${errorText}`);
    }

    return await response.json() as RerankerResponse;
  }

  private extractRelevantText(result: SearchResult): string {
    // Combine multiple text sources for better reranking
    const textParts: string[] = [];
    
    // Add file path context
    if (result.filePath) {
      textParts.push(`File: ${result.filePath}`);
    }
    
    // Add symbol information
    if (result.symbols && result.symbols.length > 0) {
      textParts.push(`Symbols: ${result.symbols.join(', ')}`);
    }
    
    // Add content
    if (result.content) {
      textParts.push(result.content);
    }
    
    return textParts.join('\n');
  }

  private mapRerankedResults(
    originalResults: SearchResult[],
    rerankedResults: RerankerResult[]
  ): SearchResult[] {
    return rerankedResults.map(reranked => {
      const original = originalResults[reranked.index];
      return {
        ...original,
        score: reranked.relevance_score // Update with reranker score
      };
    });
  }

  /**
   * Check if reranking is available (API key provided)
   */
  isAvailable(): boolean {
    return !!this.jinaApiKey;
  }

  /**
   * Get the model name for logging/debugging
   */
  getModelName(): string {
    return this.defaultModel;
  }
}
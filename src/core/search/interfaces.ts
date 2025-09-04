/**
 * Shared interfaces for search components
 */

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  filePath: string;
  startLine: number;
  endLine: number;
  language?: string;
  symbols: string[];
  metadata?: {
    relativePath?: string;
    imports?: string[];
    dependencies?: string[];
    dependents?: string[];
  };
}

export interface HybridSearchOptions {
  vectorWeight?: number;
  bm25Weight?: number;
  enableQueryEnhancement?: boolean;
  enableReranking?: boolean;
  provider?: 'openai' | 'jina';
}
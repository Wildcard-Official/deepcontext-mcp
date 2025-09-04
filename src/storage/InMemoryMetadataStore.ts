/**
 * In-Memory Metadata Store - Pure JavaScript BM25 search implementation
 * No external dependencies, fully compatible with MCP stateless architecture
 */

import { Logger } from '../utils/Logger.js';

export interface CodeChunkMetadata {
  id: string;
  codebasePath: string;
  filePath: string;
  relativePath: string;
  content: string;
  symbols: Array<{
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant';
    line: number;
  }>;
  language: string;
  startLine: number;
  endLine: number;
  fileSize: number;
  lastModified: number;
  imports?: string[];
  indexed: boolean;
  indexedAt?: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  fileTypes?: string[];
  minScore?: number;
}

export interface FTSResult {
  id: string;
  score: number;
  metadata: CodeChunkMetadata;
}

interface BM25Document {
  id: string;
  content: string;
  metadata: CodeChunkMetadata;
  terms: string[];
  termFreq: Map<string, number>;
  length: number;
}

export class InMemoryMetadataStore {
  private logger = new Logger('InMemoryMetadataStore');
  
  // Core storage
  private documents: Map<string, BM25Document> = new Map();
  private chunks: Map<string, CodeChunkMetadata> = new Map();
  
  // BM25 indexes
  private termDocumentFreq: Map<string, number> = new Map(); // term -> how many docs contain it
  private invertedIndex: Map<string, Set<string>> = new Map(); // term -> doc IDs
  private totalDocuments: number = 0;
  private avgDocumentLength: number = 0;
  private totalTerms: number = 0;
  
  // BM25 parameters
  private readonly K1 = 1.2;
  private readonly B = 0.75;
  
  // Memory monitoring
  private maxChunks = 50000; // ~400MB limit
  
  constructor() {
    this.logger.info('InMemoryMetadataStore initialized');
  }

  /**
   * Store code chunks and build BM25 index
   */
  async storeChunks(codebasePath: string, chunks: CodeChunkMetadata[]): Promise<void> {
    return this.upsertChunks(chunks);
  }

  /**
   * Upsert code chunks and build BM25 index
   */
  async upsertChunks(chunks: CodeChunkMetadata[]): Promise<void> {
    if (chunks.length === 0) return;
    
    const startTime = Date.now();
    const codebasePath = chunks[0].codebasePath; // Get codebase from first chunk
    
    // Check memory limits
    if (this.documents.size + chunks.length > this.maxChunks) {
      this.logger.warn(`Large codebase detected: ${chunks.length} chunks. Memory usage may be high.`);
      
      if (chunks.length > this.maxChunks) {
        throw new Error(`Codebase too large: ${chunks.length} files exceeds limit of ${this.maxChunks}. Consider using vector-only search.`);
      }
    }
    
    // Clear existing data for this codebase
    this.clearCodebase(codebasePath);
    
    // Process chunks in batches for better memory management
    const batchSize = 1000;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      await this.processBatch(batch);
      
      if (i % 5000 === 0) {
        this.logger.debug(`Indexed ${i}/${chunks.length} chunks`);
      }
    }
    
    // Update BM25 statistics
    this.updateBM25Stats();
    
    const indexTime = Date.now() - startTime;
    const memoryUsage = this.getMemoryStats();
    
    this.logger.info('BM25 index built', {
      chunks: chunks.length,
      terms: this.termDocumentFreq.size,
      avgDocLength: Math.round(this.avgDocumentLength),
      indexTimeMs: indexTime,
      memoryMB: Math.round(memoryUsage.totalMB)
    });
  }

  /**
   * Process a batch of chunks
   */
  private async processBatch(chunks: CodeChunkMetadata[]): Promise<void> {
    for (const chunk of chunks) {
      // Store metadata
      this.chunks.set(chunk.id, chunk);
      
      // Create BM25 document
      const terms = this.tokenize(chunk.content);
      const termFreq = this.calculateTermFrequency(terms);
      
      const document: BM25Document = {
        id: chunk.id,
        content: chunk.content,
        metadata: chunk,
        terms,
        termFreq,
        length: terms.length
      };
      
      this.documents.set(chunk.id, document);
      
      // Update inverted index
      for (const term of termFreq.keys()) {
        if (!this.invertedIndex.has(term)) {
          this.invertedIndex.set(term, new Set());
          this.termDocumentFreq.set(term, 0);
        }
        
        this.invertedIndex.get(term)!.add(chunk.id);
        this.termDocumentFreq.set(term, this.termDocumentFreq.get(term)! + 1);
      }
      
      this.totalTerms += terms.length;
    }
    
    this.totalDocuments = this.documents.size;
  }

  /**
   * Tokenize text for BM25 search
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .split(/\s+/)
      .filter(term => term.length > 1) // Remove single characters
      .filter(term => !this.isStopWord(term)); // Remove stop words
  }

  /**
   * Simple stop word filter
   */
  private isStopWord(term: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 
      'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
      'this', 'that', 'these', 'those', 'it', 'its', 'if', 'then', 'else', 'return'
    ]);
    return stopWords.has(term);
  }

  /**
   * Calculate term frequency for a document
   */
  private calculateTermFrequency(terms: string[]): Map<string, number> {
    const termFreq = new Map<string, number>();
    
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }
    
    return termFreq;
  }

  /**
   * Update BM25 statistics
   */
  private updateBM25Stats(): void {
    if (this.totalDocuments === 0) {
      this.avgDocumentLength = 0;
      return;
    }
    
    this.avgDocumentLength = this.totalTerms / this.totalDocuments;
  }

  /**
   * Perform BM25 full-text search
   */
  async searchFullText(
    codebasePath: string, 
    query: string, 
    options: SearchOptions = {}
  ): Promise<FTSResult[]> {
    const { limit = 10, offset = 0, fileTypes, minScore = 0.1 } = options;
    
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return [];
    }
    
    const scores: Map<string, number> = new Map();
    
    // Calculate BM25 scores for each query term
    for (const term of queryTerms) {
      const docIds = this.invertedIndex.get(term);
      if (!docIds) continue;
      
      const df = this.termDocumentFreq.get(term) || 0;
      const idf = Math.log((this.totalDocuments - df + 0.5) / (df + 0.5));
      
      for (const docId of docIds) {
        const document = this.documents.get(docId);
        if (!document) continue;
        
        // Filter by codebase
        if (document.metadata.codebasePath !== codebasePath) continue;
        
        // Filter by file types
        if (fileTypes && fileTypes.length > 0) {
          if (!fileTypes.includes(document.metadata.language)) continue;
        }
        
        const tf = document.termFreq.get(term) || 0;
        const docLength = document.length;
        
        // BM25 formula
        const score = idf * (tf * (this.K1 + 1)) / 
          (tf + this.K1 * (1 - this.B + this.B * (docLength / this.avgDocumentLength)));
        
        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }
    
    // Convert to results and sort by score
    const results: FTSResult[] = [];
    
    for (const [docId, score] of scores.entries()) {
      if (score < minScore) continue;
      
      const metadata = this.chunks.get(docId);
      if (metadata) {
        results.push({ id: docId, score, metadata });
      }
    }
    
    // Sort by relevance score (descending)
    results.sort((a, b) => b.score - a.score);
    
    // Apply pagination
    return results.slice(offset, offset + limit);
  }

  /**
   * Get chunks by IDs (for hybrid search)
   */
  async getChunksByIds(ids: string[]): Promise<Map<string, CodeChunkMetadata>> {
    const result = new Map<string, CodeChunkMetadata>();
    
    for (const id of ids) {
      const chunk = this.chunks.get(id);
      if (chunk) {
        result.set(id, chunk);
      }
    }
    
    return result;
  }

  /**
   * Get codebase statistics
   */
  async getCodebaseStats(codebasePath: string): Promise<{
    totalChunks: number;
    indexedChunks: number;
    languages: Record<string, number>;
    lastIndexed?: number;
  }> {
    const chunks = Array.from(this.chunks.values()).filter(
      chunk => chunk.codebasePath === codebasePath
    );
    
    const languages: Record<string, number> = {};
    let lastIndexed = 0;
    
    for (const chunk of chunks) {
      languages[chunk.language] = (languages[chunk.language] || 0) + 1;
      if (chunk.indexedAt && chunk.indexedAt > lastIndexed) {
        lastIndexed = chunk.indexedAt;
      }
    }
    
    return {
      totalChunks: chunks.length,
      indexedChunks: chunks.filter(c => c.indexed).length,
      languages,
      lastIndexed: lastIndexed || undefined
    };
  }

  /**
   * Clear all data for a codebase
   */
  clearCodebase(codebasePath: string): void {
    const chunksToRemove: string[] = [];
    
    // Find chunks to remove
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.codebasePath === codebasePath) {
        chunksToRemove.push(id);
      }
    }
    
    // Remove from all indexes
    for (const id of chunksToRemove) {
      const document = this.documents.get(id);
      if (document) {
        // Update inverted index
        for (const term of document.termFreq.keys()) {
          const docIds = this.invertedIndex.get(term);
          if (docIds) {
            docIds.delete(id);
            if (docIds.size === 0) {
              this.invertedIndex.delete(term);
              this.termDocumentFreq.delete(term);
            } else {
              this.termDocumentFreq.set(term, this.termDocumentFreq.get(term)! - 1);
            }
          }
        }
        
        this.totalTerms -= document.length;
        this.documents.delete(id);
      }
      
      this.chunks.delete(id);
    }
    
    this.totalDocuments = this.documents.size;
    this.updateBM25Stats();
    
    this.logger.info(`Cleared codebase data: ${chunksToRemove.length} chunks removed`);
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): {
    chunks: number;
    documents: number;
    terms: number;
    totalMB: number;
  } {
    // Rough memory calculation
    const chunksMB = (this.chunks.size * 2.5) / 1024; // ~2.5KB per chunk
    const indexMB = (this.termDocumentFreq.size * 0.1) / 1024; // ~100 bytes per term
    const totalMB = chunksMB + indexMB;
    
    return {
      chunks: this.chunks.size,
      documents: this.documents.size,
      terms: this.termDocumentFreq.size,
      totalMB
    };
  }

  /**
   * Check if codebase has any indexed data
   */
  hasCodebaseData(codebasePath: string): boolean {
    for (const chunk of this.chunks.values()) {
      if (chunk.codebasePath === codebasePath) {
        return true;
      }
    }
    return false;
  }
}
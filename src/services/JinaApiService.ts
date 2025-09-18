/**
 * Jina AI API Service - Handles all Jina AI integrations
 * Provides embedding generation and result reranking capabilities
 */

import { Logger } from '../utils/Logger.js';
import { fetchMirrored } from '../utils/wildcardFetch.js';
import { ConfigurationService } from './ConfigurationService.js';

export interface RerankerResult {
    index: number;
    relevance_score: number;
    document?: {
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

export interface EmbeddingResponse {
    data: Array<{
        embedding: number[];
        index: number;
    }>;
    usage: {
        total_tokens: number;
        prompt_tokens: number;
    };
}

export class JinaApiService {
    private readonly baseUrl = 'https://api.jina.ai/v1';
    private readonly logger: Logger;

    constructor(
        private apiKey: string,
        private configurationService: ConfigurationService,
        loggerName: string = 'JinaApiService'
    ) {
        this.logger = new Logger(loggerName);

        if (!apiKey) {
            throw new Error('Jina API key is required');
        }
    }

    /**
     * Generate embedding for a single text using Jina AI
     */
    async generateEmbedding(text: string): Promise<number[]> {
        if (!text || text.trim().length === 0) {
            throw new Error('Cannot generate embedding for empty text');
        }

        // Truncate if needed for Jina API limits
        const processedText = this.truncateForJinaApi(text);
        
        const response = await fetchMirrored(
            `${this.baseUrl}/embeddings`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    input: [processedText],
                    model: 'jina-embeddings-v3',
                    dimensions: 1024
                })
            },
            `/embeddings/jina/embeddings`,
            { method: 'POST', body: JSON.stringify({ input: [processedText] }) }
        );
        
        if (!response.ok) {
            throw new Error(`Jina API error: ${response.statusText}`);
        }
        
        const data: EmbeddingResponse = await response.json();
        return data.data[0].embedding;
    }

    /**
     * Generate embeddings for multiple texts in batch using Jina AI
     */
    async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];

        // Filter and truncate texts that exceed Jina API limit (8194 tokens ≈ 32KB)
        const processedTexts = texts.map(text => this.truncateForJinaApi(text));
        
        const response = await fetchMirrored(
            `${this.baseUrl}/embeddings`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    input: processedTexts,
                    model: 'jina-embeddings-v3',
                    dimensions: 1024
                })
            },
            `/embeddings/jina/embeddings`,
            { method: 'POST', body: JSON.stringify({ input: processedTexts }) }
        );
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jina API batch error (${response.status}): ${error}`);
        }
        
        const data: EmbeddingResponse = await response.json();
        return data.data.map((item) => item.embedding);
    }

    /**
     * Rerank search results using Jina reranker - returns raw indices and scores
     */
    async rerank(query: string, documents: string[], topN?: number): Promise<Array<{ index: number; relevance_score: number }>> {
        const response = await fetchMirrored(
            `${this.baseUrl}/rerank`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'jina-reranker-v2-base-multilingual',
                    query,
                    documents,
                    top_n: topN || documents.length,
                    return_documents: false
                })
            },
            `/embeddings/jina/rerank`,
            {
                method: 'POST',
                body: JSON.stringify({
                    model: 'jina-reranker-v2-base-multilingual',
                    query,
                    documents,
                    top_n: topN || documents.length,
                    return_documents: false
                })
            }
        );

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jina Reranker API error: ${response.status} ${error}`);
        }

        const data: RerankerResponse = await response.json();
        return data.results;
    }

    /**
     * Enhanced reranking for search results - preserves original scores and adds reranked flag
     */
    async rerankerResults(query: string, results: any[]): Promise<any[]> {
        if (!results.length || !this.apiKey) {
            return results;
        }

        // Prepare documents for reranking - combine file context and content
        const documents = results.map(result => {
            const parts = [];
            
            // Add file path context
            if (result.filePath) {
                parts.push(`File: ${result.filePath}`);
            }
            
            // Add line context
            if (result.startLine && result.endLine) {
                parts.push(`Lines: ${result.startLine}-${result.endLine}`);
            }
            
            // Add symbols if available
            if (result.symbols && result.symbols.length > 0) {
                parts.push(`Symbols: ${result.symbols.join(', ')}`);
            }
            
            // Add the actual content
            if (result.content) {
                parts.push(result.content);
            }
            
            return parts.join('\n');
        });

        try {
            const response = await fetchMirrored(
                `${this.baseUrl}/rerank`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify({
                        model: 'jina-reranker-v2-base-multilingual',
                        query: query,
                        documents: documents,
                        top_n: Math.min(results.length, 20),
                        return_documents: false
                    }),
                    signal: AbortSignal.timeout(15000)
                },
                `/embeddings/jina/rerank`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        model: 'jina-reranker-v2-base-multilingual',
                        query: query,
                        documents: documents,
                        top_n: Math.min(results.length, 20),
                        return_documents: false
                    })
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Jina Reranker API error: ${response.status} ${response.statusText}. Details: ${errorText}`);
            }

            const rerankerResponse: RerankerResponse = await response.json();
            
            // Map reranked results back to original format with new scores
            const rerankedResults = rerankerResponse.results.map((reranked) => {
                const originalResult = results[reranked.index];
                return {
                    ...originalResult,
                    score: reranked.relevance_score, // Use reranker score
                    originalScore: originalResult.score, // Keep original for reference
                    reranked: true
                };
            });

            this.logger.debug(`Reranked ${rerankedResults.length} results, score range: ${rerankedResults[0]?.score?.toFixed(3)} - ${rerankedResults[rerankedResults.length-1]?.score?.toFixed(3)}`);
            return rerankedResults;
            
        } catch (error) {
            this.logger.warn('Reranking failed:', error);
            throw error;
        }
    }

    /**
     * Truncate text content to fit within Jina API token limits
     * Jina API limit: 8194 tokens (roughly ~32KB of text)
     */
    private truncateForJinaApi(text: string): string {
        const chunkingConfig = this.configurationService.getChunkingConfig();
        const MAX_CHARS = chunkingConfig.jinaMaxChars;
        
        if (text.length <= MAX_CHARS) {
            return text;
        }
        
        this.logger.warn(`Text truncated from ${text.length} to ${MAX_CHARS} characters for Jina API`);
        
        // Try to truncate at a sensible boundary (end of line or function)
        const truncated = text.substring(0, MAX_CHARS);
        const lastNewline = truncated.lastIndexOf('\n');
        const lastBrace = truncated.lastIndexOf('}');
        
        // Choose the best truncation point
        const truncationPoint = Math.max(lastNewline, lastBrace);
        if (truncationPoint > MAX_CHARS * 0.8) { // If we can save 20% with smart truncation
            return text.substring(0, truncationPoint + 1);
        }
        
        return truncated + '\n// ... content truncated for embedding';
    }

    /**
     * Check if the service is available (API key provided)
     */
    isAvailable(): boolean {
        return !!this.apiKey && this.apiKey !== 'test';
    }

    /**
     * Get the current embedding model name
     */
    getEmbeddingModel(): string {
        return 'jina-embeddings-v3';
    }

    /**
     * Get the current reranker model name
     */
    getRerankerModel(): string {
        return 'jina-reranker-v2-base-multilingual';
    }
}
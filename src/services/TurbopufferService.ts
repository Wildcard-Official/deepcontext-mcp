/**
 * Turbopuffer Vector Store Service
 * Handles all Turbopuffer API operations including vector storage, querying, and hybrid search
 */

import { Logger } from '../utils/Logger.js';
import { TurbopufferStore } from './HybridSearchService.js';

export interface VectorStoreResult {
    id: string;
    score: number;
    metadata: any;
}

export interface HybridSearchOptions {
    embedding: number[];
    query: string;
    limit?: number;
    vectorWeight?: number;
    bm25Weight?: number;
    filters?: any;
}

export interface QueryOptions {
    embedding?: number[];
    query?: string;
    rank_by?: any[];
    limit?: number;
    filters?: any;
    include_attributes?: string[];
}

export class TurbopufferService implements TurbopufferStore {
    private readonly baseUrl = 'https://gcp-us-central1.turbopuffer.com/v2';
    private readonly logger: Logger;

    constructor(private apiKey: string, loggerName: string = 'TurbopufferService') {
        this.logger = new Logger(loggerName);
        
        if (!apiKey) {
            throw new Error('Turbopuffer API key is required');
        }
    }

    /**
     * Upsert vectors to Turbopuffer namespace
     */
    async upsert(namespace: string, vectors: any[]): Promise<void> {
        const response = await fetch(`${this.baseUrl}/namespaces/${namespace}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
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

    /**
     * Query Turbopuffer namespace with various options
     */
    async query(namespace: string, options: QueryOptions): Promise<VectorStoreResult[]> {
        const requestBody: any = {
            include_attributes: options.include_attributes || ['content', 'filePath', 'startLine', 'endLine', 'language'],
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
            // BM25 text search (use array format like hybrid search)
            requestBody.rank_by = ['content', 'BM25', options.query];
        }

        // Add filters if provided
        if (options.filters) {
            requestBody.filters = options.filters;
        }

        const response = await fetch(`${this.baseUrl}/namespaces/${namespace}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
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
     * Basic search implementation for TurbopufferStore interface
     */
    async search(namespace: string, options: any): Promise<VectorStoreResult[]> {
        return await this.query(namespace, options);
    }

    /**
     * Advanced hybrid search combining vector similarity and BM25 with RRF fusion
     */
    async hybridSearch(namespace: string, options: HybridSearchOptions): Promise<VectorStoreResult[]> {
        const limit = options.limit || 10;
        const vectorWeight = options.vectorWeight || 0.6; // Reduced for better balance
        const bm25Weight = options.bm25Weight || 0.4; // Increased for better keyword matching
        
        // Use Turbopuffer's queries array format (same as backend implementation)
        const response = await fetch(`${this.baseUrl}/namespaces/${namespace}/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                queries: [
                    // Vector search query
                    {
                        rank_by: ['vector', 'ANN', options.embedding],
                        top_k: Math.min(limit * 2, 50),
                        include_attributes: true
                    },
                    // BM25 search query
                    {
                        rank_by: ['content', 'BM25', options.query],
                        top_k: Math.min(limit * 2, 50),
                        include_attributes: true
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
     * Check if a namespace exists
     */
    async checkNamespaceExists(namespace: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/namespaces/${namespace}`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Clear/delete an entire namespace
     */
    async clearNamespace(namespace: string): Promise<void> {
        try {
            const response = await fetch(`${this.baseUrl}/namespaces/${namespace}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                }
            });
            
            if (response.ok) {
                this.logger.info(`✅ Cleared namespace: ${namespace}`);
            }
        } catch (error) {
            this.logger.warn(`Failed to clear namespace ${namespace}:`, error);
        }
    }

    /**
     * Get chunk IDs for a specific file (for atomic updates)
     */
    async getChunkIdsForFile(namespace: string, filePath: string): Promise<string[]> {
        try {
            const allChunkIds: string[] = [];
            let hasMore = true;
            
            while (hasMore) {
                const queryResponse = await fetch(`${this.baseUrl}/namespaces/${namespace}/query`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        filters: [['filePath', 'Eq', filePath]],
                        top_k: 1000,
                        include_attributes: false
                    })
                });

                if (!queryResponse.ok) {
                    if (queryResponse.status === 422) {
                        // Namespace doesn't exist yet - no existing chunks to find
                        return allChunkIds; // Return empty array
                    }
                    throw new Error(`Query failed: ${queryResponse.status}`);
                }

                const queryData = await queryResponse.json();
                const chunkIds = (queryData.rows || []).map((row: any) => row.id);

                if (chunkIds.length === 0) {
                    hasMore = false;
                } else {
                    allChunkIds.push(...chunkIds);
                    hasMore = chunkIds.length === 1000; // Continue if we got a full batch
                }
            }

            return allChunkIds;
        } catch (error) {
            this.logger.warn(`Failed to get existing chunk IDs for ${filePath}: ${error}`);
            return []; // Return empty array on error - better to have duplicates than lose data
        }
    }

    /**
     * Delete chunks by their IDs (for atomic updates)
     */
    async deleteChunksByIds(namespace: string, chunkIds: string[]): Promise<number> {
        if (chunkIds.length === 0) return 0;

        try {
            let totalDeleted = 0;
            
            // Process in batches of 1000 for safety
            for (let i = 0; i < chunkIds.length; i += 1000) {
                const batch = chunkIds.slice(i, i + 1000);
                
                const deleteResponse = await fetch(`${this.baseUrl}/namespaces/${namespace}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        deletes: batch
                    })
                });

                if (!deleteResponse.ok) {
                    const error = await deleteResponse.text();
                    throw new Error(`Delete batch failed: ${deleteResponse.status} ${error}`);
                }

                totalDeleted += batch.length;
            }

            return totalDeleted;
        } catch (error) {
            throw new Error(`Failed to delete chunks: ${error}`);
        }
    }

    /**
     * Fuse hybrid search results using optimized RRF (Reciprocal Rank Fusion)
     * Enhanced formula for better score distribution: score = weight * (base / (k + rank))
     * where base is scaled for better differentiation
     */
    private fuseHybridResults(
        multiQueryResults: any,
        limit: number,
        weights: { vectorWeight: number; bm25Weight: number }
    ): VectorStoreResult[] {
        const scores = new Map<string, number>();
        const metadata = new Map<string, any>();
        
        // Optimized RRF parameters for better score distribution
        const k = 10; // Reduced from 60 for less compression
        const scoreBase = 100; // Scale up scores for better differentiation
        const minScoreThreshold = 0.01; // Minimum meaningful score
        
        // Extract results from Turbopuffer response: { results: [{ rows: [...] }, { rows: [...] }] }
        const vectorResults = multiQueryResults.results?.[0]?.rows || [];
        const bm25Results = multiQueryResults.results?.[1]?.rows || [];
        
        this.logger.info(`Hybrid search - Vector: ${vectorResults.length}, BM25: ${bm25Results.length}`);
        
        // Process vector search results (first query)
        vectorResults.forEach((item: any, rank: number) => {
            const reciprocalRank = weights.vectorWeight * scoreBase / (k + rank + 1);
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
            const reciprocalRank = weights.bm25Weight * scoreBase / (k + rank + 1);
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
            .map(([id, score]) => [id, score] as [string, number])
            .filter(([id, score]) => {
                // Only filter out very low scores, keep all legitimate files
                return score >= minScoreThreshold;
            })
            .map(([id, score], index, array) => {
                const meta = metadata.get(id);
                
                // Enhanced score normalization for better differentiation
                const maxScore = array[0]?.[1] || 1;
                const normalizedScore = Math.min(1.0, score / maxScore);
                
                // Apply rank bonus to prevent score compression
                const rankBonus = Math.max(0, (array.length - index) / array.length * 0.2);
                const finalScore = Math.min(1.0, normalizedScore + rankBonus);
                
                return {
                    id,
                    score: finalScore,
                    metadata: meta
                };
            })
            // Remove duplicate chunks from the same file/function
            .filter((result, index, array) => {
                const current = result.metadata;
                const key = `${current?.filePath}:${current?.startLine}-${current?.endLine}`;
                
                // Keep first occurrence, remove subsequent duplicates
                return array.findIndex(r => {
                    const m = r.metadata;
                    const compareKey = `${m?.filePath}:${m?.startLine}-${m?.endLine}`;
                    return compareKey === key;
                }) === index;
            })
            // Remove overlapping chunks (same function with different line ranges)
            .filter((result, index, array) => {
                const current = result.metadata;
                if (!current?.filePath) return true;
                
                // Check if this chunk overlaps significantly with a higher-scored chunk
                return !array.slice(0, index).some(r => {
                    const other = r.metadata;
                    if (other?.filePath !== current.filePath) return false;
                    
                    // Calculate overlap
                    const overlapStart = Math.max(current.startLine || 0, other.startLine || 0);
                    const overlapEnd = Math.min(current.endLine || 0, other.endLine || 0);
                    const overlap = Math.max(0, overlapEnd - overlapStart);
                    
                    // If >70% overlap, consider it duplicate
                    const currentSize = (current.endLine || 0) - (current.startLine || 0);
                    const overlapRatio = currentSize > 0 ? overlap / currentSize : 0;
                    
                    return overlapRatio > 0.7;
                });
            })
            .slice(0, limit);
        
        this.logger.info(`Fusion completed - Final: ${finalResults.length} results`);
        
        return finalResults;
    }

    /**
     * Check if the service is available (API key provided)
     */
    isAvailable(): boolean {
        return !!this.apiKey && this.apiKey !== 'test';
    }
}
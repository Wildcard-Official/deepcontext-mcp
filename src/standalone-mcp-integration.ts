/**
 * Integration layer that combines the new core architecture 
 * with the working standalone MCP implementation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// Core components
import { IndexingOrchestrator } from './core/indexing/IndexingOrchestrator.js';
import { SemanticSearchEngine } from './core/search/SemanticSearchEngine.js';
import { IncrementalIndexer } from './core/indexing/IncrementalIndexer.js';
import { FileUtils } from './utils/FileUtils.js';
import { Logger } from './utils/Logger.js';

// Types from IndexingOrchestrator (actual implementation)
import type { 
    IndexingRequest,
    IndexingResult,
    CodeChunk as CoreChunk
} from './core/indexing/IndexingOrchestrator.js';

// Types from SearchEngine
import type {
    SearchRequest,
    SearchResponse
} from './core/search/SemanticSearchEngine.js';

interface CodeChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbols: string[];
    score?: number;
}

interface IndexedCodebase {
    path: string;
    namespace: string;
    totalChunks: number;
    indexedAt: string;
}

interface StandaloneConfig {
    jinaApiKey: string;
    turbopufferApiKey: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class StandaloneCodexMcp {
    private config: StandaloneConfig;
    private indexingOrchestrator: IndexingOrchestrator;
    private searchEngine: SemanticSearchEngine;
    private incrementalIndexer: IncrementalIndexer;
    private fileUtils: FileUtils;
    private logger: Logger;
    
    // Vector store integration
    private turbopufferApiUrl = 'https://gcp-us-central1.turbopuffer.com/v2';
    private jinaApiUrl = 'https://api.jina.ai/v1/embeddings';
    
    // State management
    private indexedCodebases: Map<string, IndexedCodebase> = new Map();

    constructor(config?: Partial<StandaloneConfig>) {
        this.config = {
            jinaApiKey: config?.jinaApiKey || process.env.JINA_API_KEY || 'test',
            turbopufferApiKey: config?.turbopufferApiKey || process.env.TURBOPUFFER_API_KEY || 'test',
            logLevel: config?.logLevel || 'info'
        };
        
        this.logger = new Logger('STANDALONE-INTEGRATION', this.config.logLevel);
        this.fileUtils = new FileUtils();
        this.indexingOrchestrator = new IndexingOrchestrator();
        this.incrementalIndexer = new IncrementalIndexer();
        
        // Create vector store and embedding integrations
        const vectorStore = this.createVectorStoreIntegration();
        const embedding = this.createEmbeddingIntegration();
        this.searchEngine = new SemanticSearchEngine(vectorStore, embedding);
    }

    /**
     * Index a codebase using the new architecture but with real API calls
     */
    async indexCodebaseIntelligent(codebasePath: string, forceReindex = false): Promise<{
        success: boolean;
        namespace: string;
        filesProcessed: number;
        chunksCreated: number;
        processingTimeMs: number;
        message: string;
    }> {
        const startTime = Date.now();
        
        try {
            this.logger.info(`Starting intelligent indexing for: ${codebasePath}`);
            
            // Use new architecture for indexing
            const indexingRequest: IndexingRequest = {
                codebasePath,
                force: forceReindex,
                enableContentFiltering: true,
                enableDependencyAnalysis: true,
                enableIncrementalUpdate: !forceReindex
            };

            const result = await this.indexingOrchestrator.indexCodebase(indexingRequest);
            
            if (!result.success) {
                return {
                    success: false,
                    namespace: '',
                    filesProcessed: 0,
                    chunksCreated: 0,
                    processingTimeMs: Date.now() - startTime,
                    message: `Indexing failed with ${result.errors.length} errors`
                };
            }
            
            // Convert core chunks to standalone format for API upload
            const standaloneChunks: CodeChunk[] = result.chunks.map(chunk => ({
                id: chunk.id,
                content: chunk.content,
                filePath: chunk.filePath,
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: chunk.language,
                symbols: chunk.symbols?.map(s => s.name) || []
            }));

            // Upload to vector store using real API
            await this.uploadChunksToVectorStore(result.metadata.namespace, standaloneChunks);
            
            // Store indexing metadata
            const normalizedPath = path.resolve(codebasePath);
            const indexedCodebase: IndexedCodebase = {
                path: normalizedPath,
                namespace: result.metadata.namespace,
                totalChunks: standaloneChunks.length,
                indexedAt: new Date().toISOString()
            };
            
            this.indexedCodebases.set(normalizedPath, indexedCodebase);
            await this.saveIndexedCodebases();

            const processingTime = Date.now() - startTime;
            
            this.logger.info(`✅ Indexing completed: ${result.metadata.totalFiles} files, ${standaloneChunks.length} chunks`);
            
            return {
                success: true,
                namespace: result.metadata.namespace,
                filesProcessed: result.metadata.totalFiles,
                chunksCreated: standaloneChunks.length,
                processingTimeMs: processingTime,
                message: `Successfully indexed ${result.metadata.totalFiles} files into ${standaloneChunks.length} intelligent chunks`
            };
            
        } catch (error) {
            this.logger.error('Indexing failed:', error);
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                processingTimeMs: Date.now() - startTime,
                message: `Indexing failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Search using new architecture with real API calls
     */
    async searchWithIntelligence(query: string, codebasePath?: string, maxResults = 10): Promise<{
        success: boolean;
        results: CodeChunk[];
        totalResults: number;
        searchTimeMs: number;
        message: string;
    }> {
        const startTime = Date.now();
        
        try {
            // Determine namespace from codebase path or use first available
            let namespace: string;
            
            if (codebasePath) {
                // Normalize path for comparison
                const normalizedPath = path.resolve(codebasePath);
                const indexed = this.indexedCodebases.get(normalizedPath);
                if (!indexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: `Codebase not indexed. Please index ${codebasePath} first.`
                    };
                }
                namespace = indexed.namespace;
            } else {
                // Use first available namespace
                const firstIndexed = Array.from(this.indexedCodebases.values())[0];
                if (!firstIndexed) {
                    return {
                        success: false,
                        results: [],
                        totalResults: 0,
                        searchTimeMs: Date.now() - startTime,
                        message: 'No codebases indexed. Run indexing first.'
                    };
                }
                namespace = firstIndexed.namespace;
            }

            // Use new architecture for search
            const searchRequest: SearchRequest = {
                codebasePath: codebasePath || '',
                query,
                limit: maxResults,
                includeRelatedSymbols: true,
                enableReranking: true,
                searchStrategy: 'hybrid'
            };

            const searchResponse = await this.searchEngine.search(searchRequest);
            
            // Convert to standalone format
            const results: CodeChunk[] = searchResponse.matches.map(match => ({
                id: match.id,
                content: match.content,
                filePath: match.filePath,
                relativePath: match.relativePath,
                startLine: match.startLine,
                endLine: match.endLine,
                language: match.language || 'unknown',
                symbols: match.symbols?.map(s => s.name) || [],
                score: match.score
            }));

            const searchTime = Date.now() - startTime;
            
            return {
                success: true,
                results,
                totalResults: results.length,
                searchTimeMs: searchTime,
                message: `Found ${results.length} relevant results`
            };
            
        } catch (error) {
            this.logger.error('Search failed:', error);
            return {
                success: false,
                results: [],
                totalResults: 0,
                searchTimeMs: Date.now() - startTime,
                message: `Search failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Get indexing status using new architecture
     */
    async getIndexingStatus(codebasePath?: string): Promise<{
        indexedCodebases: IndexedCodebase[];
        currentCodebase?: IndexedCodebase;
        incrementalStats?: any;
    }> {
        const indexedList = Array.from(this.indexedCodebases.values());
        
        let currentCodebase: IndexedCodebase | undefined;
        let incrementalStats: any;
        
        if (codebasePath) {
            currentCodebase = this.indexedCodebases.get(codebasePath);
            if (currentCodebase) {
                try {
                    incrementalStats = await this.incrementalIndexer.getIndexStats(codebasePath);
                } catch (error) {
                    this.logger.warn('Could not get incremental stats:', error);
                }
            }
        }

        return {
            indexedCodebases: indexedList,
            currentCodebase,
            incrementalStats
        };
    }

    /**
     * Clear index using real API calls
     */
    async clearIndex(codebasePath?: string): Promise<{
        success: boolean;
        message: string;
        clearedNamespaces: string[];
    }> {
        try {
            const namespacesToClear: string[] = [];
            
            if (codebasePath) {
                const indexed = this.indexedCodebases.get(codebasePath);
                if (indexed) {
                    namespacesToClear.push(indexed.namespace);
                    this.indexedCodebases.delete(codebasePath);
                    
                    // Clear incremental metadata
                    await this.incrementalIndexer.forceFullReindex(codebasePath);
                }
            } else {
                // Clear all
                for (const indexed of this.indexedCodebases.values()) {
                    namespacesToClear.push(indexed.namespace);
                }
                this.indexedCodebases.clear();
            }

            // Clear from vector store
            for (const namespace of namespacesToClear) {
                await this.clearVectorStoreNamespace(namespace);
            }

            await this.saveIndexedCodebases();
            
            return {
                success: true,
                message: `Cleared ${namespacesToClear.length} namespace(s)`,
                clearedNamespaces: namespacesToClear
            };
            
        } catch (error) {
            this.logger.error('Clear index failed:', error);
            return {
                success: false,
                message: `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
                clearedNamespaces: []
            };
        }
    }

    // Vector store integration methods
    private createVectorStoreIntegration(): any {
        return {
            search: async (query: string, namespace: string, limit: number) => {
                return await this.vectorStoreSearch(query, namespace, limit);
            },
            searchBySymbols: async (symbols: string[], namespace: string, limit: number) => {
                return await this.vectorStoreSymbolSearch(symbols, namespace, limit);
            },
            getDependencyGraph: async (namespace: string) => {
                return null; // Not implemented in turbopuffer
            },
            hasNamespace: async (namespace: string) => {
                return await this.checkNamespaceExists(namespace);
            }
        };
    }

    private createEmbeddingIntegration(): any {
        return {
            embed: async (text: string) => {
                return await this.generateEmbedding(text);
            },
            embedBatch: async (texts: string[]) => {
                return await this.generateEmbeddingBatch(texts);
            }
        };
    }

    // Real API integration methods
    private async uploadChunksToVectorStore(namespace: string, chunks: CodeChunk[]): Promise<void> {
        if (!chunks.length) return;
        
        this.logger.info(`Uploading ${chunks.length} chunks to vector store...`);
        
        const batchSize = 50;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            
            // Generate embeddings for batch
            const embeddings = await this.generateEmbeddingBatch(
                batch.map(chunk => chunk.content)
            );
            
            // Prepare upsert data in Turbopuffer v2 format
            const upsertData = batch.map((chunk, idx) => ({
                id: chunk.id,
                vector: embeddings[idx],
                content: chunk.content,
                filePath: chunk.filePath,
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: chunk.language,
                symbols: chunk.symbols.join(',')
            }));
            
            // Upload to Turbopuffer
            await this.turbopufferUpsert(namespace, upsertData);
        }
        
        this.logger.info(`✅ Uploaded ${chunks.length} chunks to namespace: ${namespace}`);
    }

    private async vectorStoreSearch(query: string, namespace: string, limit: number): Promise<any[]> {
        const queryEmbedding = await this.generateEmbedding(query);
        return await this.turbopufferQuery(namespace, queryEmbedding, limit);
    }

    private async vectorStoreSymbolSearch(symbols: string[], namespace: string, limit: number): Promise<any[]> {
        const symbolQuery = symbols.join(' ');
        return await this.vectorStoreSearch(symbolQuery, namespace, limit);
    }

    private async checkNamespaceExists(namespace: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
                headers: { 'Authorization': `Bearer ${this.config.turbopufferApiKey}` }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // Jina AI integration
    private async generateEmbedding(text: string): Promise<number[]> {
        const response = await fetch(this.jinaApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.jinaApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: [text],
                model: 'jina-embeddings-v3',
                dimensions: 1024
            })
        });
        
        if (!response.ok) {
            throw new Error(`Jina API error: ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.data[0].embedding;
    }

    private async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        
        const response = await fetch(this.jinaApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.jinaApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: texts,
                model: 'jina-embeddings-v3',
                dimensions: 1024
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jina API batch error (${response.status}): ${error}`);
        }
        
        const data = await response.json();
        return data.data.map((item: any) => item.embedding);
    }

    // Turbopuffer integration
    private async turbopufferUpsert(namespace: string, vectors: any[]): Promise<void> {
        const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.turbopufferApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                upsert_rows: vectors,
                distance_metric: 'cosine_distance'
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Turbopuffer upsert error (${response.status}): ${error}`);
        }
    }

    private async turbopufferQuery(namespace: string, vector: number[], limit: number): Promise<any[]> {
        const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.turbopufferApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                rank_by: ['vector', 'ANN', vector],
                top_k: limit,
                include_attributes: ['content', 'filePath', 'relativePath', 'startLine', 'endLine', 'language', 'symbols']
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Turbopuffer query error: ${error}`);
        }
        
        const data = await response.json();
        return data.rows || [];
    }

    private async clearVectorStoreNamespace(namespace: string): Promise<void> {
        try {
            const response = await fetch(`${this.turbopufferApiUrl}/namespaces/${namespace}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.config.turbopufferApiKey}`
                }
            });
            
            if (response.ok) {
                this.logger.info(`✅ Cleared namespace: ${namespace}`);
            }
        } catch (error) {
            this.logger.warn(`Failed to clear namespace ${namespace}:`, error);
        }
    }

    // Persistence
    private getIndexedCodebasesPath(): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        return path.join(dataDir, 'indexed-codebases.json');
    }

    private async saveIndexedCodebases(): Promise<void> {
        try {
            const dataPath = this.getIndexedCodebasesPath();
            const dir = path.dirname(dataPath);
            
            await fs.mkdir(dir, { recursive: true });
            
            const data = Array.from(this.indexedCodebases.entries());
            await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
        } catch (error) {
            this.logger.warn('Failed to save indexed codebases:', error);
        }
    }

    private async loadIndexedCodebases(): Promise<void> {
        try {
            const dataPath = this.getIndexedCodebasesPath();
            const content = await fs.readFile(dataPath, 'utf-8');
            const data = JSON.parse(content);
            
            this.indexedCodebases = new Map(data);
        } catch (error) {
            // No existing data, start fresh
            this.indexedCodebases = new Map();
        }
    }

    async initialize(): Promise<void> {
        await this.loadIndexedCodebases();
        this.logger.info(`Loaded ${this.indexedCodebases.size} indexed codebases`);
    }
}
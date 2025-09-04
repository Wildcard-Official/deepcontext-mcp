/**
 * SemanticSearchEngine - Advanced semantic search with dependency context
 * 
 * Provides intelligent code search with:
 * - Vector similarity search
 * - Cross-file dependency expansion
 * - Symbol relationship context
 * - Multi-stage result ranking
 * - Configurable search strategies
 */

import * as crypto from 'crypto';
import * as path from 'path';

export interface SearchRequest {
    codebasePath: string;
    query: string;
    explanation?: string;
    limit?: number;
    minScore?: number;
    includeRelatedSymbols?: boolean;
    enableReranking?: boolean;
    searchStrategy?: 'semantic' | 'hybrid' | 'structural';
    fileTypes?: string[];
    symbolTypes?: string[];
    contextWindow?: number; // Lines of context around matches
}

export interface SearchMatch {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    originalScore?: number;
    rerankScore?: number;
    matchType: 'exact' | 'semantic' | 'dependency' | 'symbol';
    symbols: Array<{
        name: string;
        type: string;
        line: number;
    }>;
    imports: Array<{
        module: string;
        symbols: string[];
        line: number;
    }>;
    dependencies: string[];
    dependents: string[];
    contextBefore?: string;
    contextAfter?: string;
    relatedMatches?: string[]; // IDs of related matches
}

export interface SearchResponse {
    matches: SearchMatch[];
    metadata: {
        totalMatches: number;
        searchTime: number;
        strategy: string;
        features: {
            semanticSearch: boolean;
            dependencyExpansion: boolean;
            reranking: boolean;
            contextExpansion: boolean;
        };
        queryAnalysis: {
            intent: 'find_function' | 'find_class' | 'find_pattern' | 'find_usage' | 'general';
            extractedSymbols: string[];
            suggestedSymbolTypes: string[];
        };
    };
    suggestions?: {
        alternativeQueries: string[];
        relatedSymbols: string[];
        similarCodePatterns: string[];
    };
}

interface VectorStore {
    search(namespace: string, options: {
        embedding: number[];
        limit: number;
        minScore?: number;
        fileTypes?: string[];
    }): Promise<any[]>;
    searchBySymbols(namespace: string, symbols: string[], limit: number): Promise<any[]>;
    getDependencyGraph(namespace: string): Promise<any>;
    hasNamespace(namespace: string): Promise<boolean>;
}

interface EmbeddingProvider {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
}

interface RerankerProvider {
    rerank(query: string, documents: string[]): Promise<Array<{ index: number; score: number }>>;
}

export class SemanticSearchEngine {
    constructor(
        private vectorStore: VectorStore,
        private embeddingProvider: EmbeddingProvider,
        private rerankerProvider?: RerankerProvider
    ) {}

    /**
     * Main search method
     */
    async search(request: SearchRequest): Promise<SearchResponse> {
        const startTime = Date.now();
        const namespace = this.generateNamespace(request.codebasePath);

        console.log(`[SEARCH] 🔍 Query: "${request.query}"`);
        console.log(`[SEARCH] 🎯 Strategy: ${request.searchStrategy || 'semantic'}`);
        console.log(`[SEARCH] 📋 Namespace: ${namespace}`);

        // Verify codebase is indexed
        if (!await this.vectorStore.hasNamespace(namespace)) {
            throw new Error(`Codebase not indexed. Please index ${request.codebasePath} first.`);
        }

        // Analyze query intent and extract key information
        const queryAnalysis = this.analyzeQuery(request.query);
        console.log(`[SEARCH] 🧠 Intent: ${queryAnalysis.intent}, Symbols: [${queryAnalysis.extractedSymbols.join(', ')}]`);

        // Execute search based on strategy
        let matches: SearchMatch[] = [];
        
        switch (request.searchStrategy || 'semantic') {
            case 'semantic':
                matches = await this.semanticSearch(request, namespace, queryAnalysis);
                break;
            case 'hybrid':
                matches = await this.hybridSearch(request, namespace, queryAnalysis);
                break;
            case 'structural':
                matches = await this.structuralSearch(request, namespace, queryAnalysis);
                break;
        }

        console.log(`[SEARCH] 📊 Initial matches: ${matches.length}`);

        // Apply filters
        matches = this.applyFilters(matches, request);

        // Expand with dependency context if enabled
        if (request.includeRelatedSymbols !== false && matches.length > 0) {
            matches = await this.expandWithDependencies(matches, namespace, request.limit || 10);
            console.log(`[SEARCH] 🔗 After dependency expansion: ${matches.length}`);
        }

        // Add context windows if requested
        if (request.contextWindow && request.contextWindow > 0) {
            matches = await this.addContextWindows(matches, request.contextWindow);
        }

        // Apply reranking if enabled
        if (request.enableReranking !== false && this.rerankerProvider && matches.length > 1) {
            matches = await this.rerankResults(request.query, matches);
            console.log('[SEARCH] 🔄 Applied reranking');
        }

        // Identify related matches
        this.identifyRelatedMatches(matches);

        // Sort by final score and limit results
        matches = matches
            .sort((a, b) => b.score - a.score)
            .slice(0, request.limit || 10);

        const searchTime = Date.now() - startTime;
        console.log(`[SEARCH] ✅ Search completed: ${matches.length} matches in ${searchTime}ms`);

        // Generate suggestions
        const suggestions = await this.generateSuggestions(request, matches, queryAnalysis);

        return {
            matches,
            metadata: {
                totalMatches: matches.length,
                searchTime,
                strategy: request.searchStrategy || 'semantic',
                features: {
                    semanticSearch: true,
                    dependencyExpansion: request.includeRelatedSymbols !== false,
                    reranking: request.enableReranking !== false && !!this.rerankerProvider,
                    contextExpansion: !!request.contextWindow
                },
                queryAnalysis
            },
            suggestions
        };
    }

    /**
     * Semantic vector search
     */
    private async semanticSearch(
        request: SearchRequest,
        namespace: string,
        queryAnalysis: any
    ): Promise<SearchMatch[]> {
        // Generate query embedding
        const queryEmbedding = await this.embeddingProvider.embed(request.query);

        // Search vector store
        const results = await this.vectorStore.search(namespace, {
            embedding: queryEmbedding,
            limit: Math.min((request.limit || 10) * 2, 50), // Get more for filtering
            minScore: request.minScore || 0.3,
            fileTypes: request.fileTypes
        });

        return this.convertToSearchMatches(results, 'semantic');
    }

    /**
     * Hybrid search combining semantic and structural approaches
     */
    private async hybridSearch(
        request: SearchRequest,
        namespace: string,
        queryAnalysis: any
    ): Promise<SearchMatch[]> {
        const matches: SearchMatch[] = [];

        // 1. Semantic search
        const semanticMatches = await this.semanticSearch(request, namespace, queryAnalysis);
        matches.push(...semanticMatches.map(m => ({ ...m, score: m.score * 0.7 }))); // Reduce weight

        // 2. Symbol-based search if symbols were detected
        if (queryAnalysis.extractedSymbols.length > 0) {
            const symbolMatches = await this.symbolSearch(
                namespace, 
                queryAnalysis.extractedSymbols,
                Math.min(request.limit || 10, 20)
            );
            matches.push(...symbolMatches.map(m => ({ ...m, score: m.score * 0.3, matchType: 'symbol' as const })));
        }

        // 3. Merge and deduplicate
        return this.mergeAndDeduplicateMatches(matches);
    }

    /**
     * Structural search focusing on code patterns and symbols
     */
    private async structuralSearch(
        request: SearchRequest,
        namespace: string,
        queryAnalysis: any
    ): Promise<SearchMatch[]> {
        const matches: SearchMatch[] = [];

        // Focus on symbol matches
        if (queryAnalysis.extractedSymbols.length > 0) {
            const symbolMatches = await this.symbolSearch(
                namespace,
                queryAnalysis.extractedSymbols,
                request.limit || 10
            );
            matches.push(...symbolMatches);
        }

        // If no symbols found, fall back to semantic search
        if (matches.length === 0) {
            return await this.semanticSearch(request, namespace, queryAnalysis);
        }

        return matches;
    }

    /**
     * Symbol-based search
     */
    private async symbolSearch(
        namespace: string,
        symbols: string[],
        limit: number
    ): Promise<SearchMatch[]> {
        const results = await this.vectorStore.searchBySymbols(namespace, symbols, limit);
        return this.convertToSearchMatches(results, 'symbol');
    }

    /**
     * Expand results with dependency context
     */
    private async expandWithDependencies(
        matches: SearchMatch[],
        namespace: string,
        targetLimit: number
    ): Promise<SearchMatch[]> {
        try {
            const dependencyGraph = await this.vectorStore.getDependencyGraph(namespace);
            if (!dependencyGraph) {
                return matches;
            }

            // Extract symbols from current matches
            const currentSymbols = new Set<string>();
            for (const match of matches) {
                match.symbols.forEach(s => currentSymbols.add(s.name));
            }

            // Find related symbols
            const relatedSymbols = this.findRelatedSymbols(currentSymbols, dependencyGraph);
            
            if (relatedSymbols.size === 0) {
                return matches;
            }

            console.log(`[SEARCH] 🔗 Found ${relatedSymbols.size} related symbols`);

            // Search for chunks containing related symbols
            const relatedMatches = await this.symbolSearch(
                namespace,
                Array.from(relatedSymbols),
                targetLimit - matches.length
            );

            // Merge with existing matches
            const allMatches = [...matches];
            const existingIds = new Set(matches.map(m => m.id));

            for (const match of relatedMatches) {
                if (!existingIds.has(match.id) && allMatches.length < targetLimit) {
                    // Boost score for dependency-related matches but cap it
                    allMatches.push({
                        ...match,
                        score: Math.min(match.score * 1.1, 0.95),
                        matchType: 'dependency'
                    });
                }
            }

            return allMatches;

        } catch (error) {
            console.warn(`[SEARCH] ⚠️ Dependency expansion failed: ${error}`);
            return matches;
        }
    }

    /**
     * Apply filters to search results
     */
    private applyFilters(matches: SearchMatch[], request: SearchRequest): SearchMatch[] {
        let filtered = matches;

        // Filter by symbol types if specified
        if (request.symbolTypes && request.symbolTypes.length > 0) {
            filtered = filtered.filter(match =>
                match.symbols.some(symbol =>
                    request.symbolTypes!.includes(symbol.type)
                )
            );
        }

        // Filter by minimum score
        if (request.minScore) {
            filtered = filtered.filter(match => match.score >= request.minScore!);
        }

        return filtered;
    }

    /**
     * Add context windows around matches
     */
    private async addContextWindows(
        matches: SearchMatch[],
        contextLines: number
    ): Promise<SearchMatch[]> {
        // This would read file content and add context
        // Simplified implementation for now
        for (const match of matches) {
            try {
                // In a real implementation, we'd read the file and extract context
                match.contextBefore = `// ${contextLines} lines before...`;
                match.contextAfter = `// ${contextLines} lines after...`;
            } catch (error) {
                console.warn(`[SEARCH] Could not add context for ${match.filePath}: ${error}`);
            }
        }

        return matches;
    }

    /**
     * Rerank results using external reranker
     */
    private async rerankResults(query: string, matches: SearchMatch[]): Promise<SearchMatch[]> {
        if (!this.rerankerProvider) {
            return matches;
        }

        try {
            const documents = matches.map(match => match.content);
            const reranked = await this.rerankerProvider.rerank(query, documents);

            return reranked.map(result => ({
                ...matches[result.index],
                originalScore: matches[result.index].score,
                rerankScore: result.score,
                score: result.score
            }));

        } catch (error) {
            console.warn(`[SEARCH] ⚠️ Reranking failed: ${error}`);
            return matches;
        }
    }

    /**
     * Analyze query to understand intent and extract symbols
     */
    private analyzeQuery(query: string): {
        intent: 'find_function' | 'find_class' | 'find_pattern' | 'find_usage' | 'general';
        extractedSymbols: string[];
        suggestedSymbolTypes: string[];
    } {
        const lowerQuery = query.toLowerCase();
        
        // Determine intent
        let intent: 'find_function' | 'find_class' | 'find_pattern' | 'find_usage' | 'general' = 'general';
        
        if (lowerQuery.includes('function') || lowerQuery.includes('method')) {
            intent = 'find_function';
        } else if (lowerQuery.includes('class') || lowerQuery.includes('type')) {
            intent = 'find_class';
        } else if (lowerQuery.includes('usage') || lowerQuery.includes('used') || lowerQuery.includes('calls')) {
            intent = 'find_usage';
        } else if (lowerQuery.includes('pattern') || lowerQuery.includes('like') || lowerQuery.includes('similar')) {
            intent = 'find_pattern';
        }

        // Extract potential symbol names (simple heuristic)
        const symbolPattern = /\b[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?=[A-Z])|[a-zA-Z_][a-zA-Z0-9_]*(?=\()/g;
        const extractedSymbols = [...new Set((query.match(symbolPattern) || []).filter(s => s.length > 2))];

        // Suggest symbol types based on intent
        let suggestedSymbolTypes: string[] = [];
        switch (intent) {
            case 'find_function':
                suggestedSymbolTypes = ['function', 'method'];
                break;
            case 'find_class':
                suggestedSymbolTypes = ['class', 'interface', 'type'];
                break;
            default:
                suggestedSymbolTypes = ['function', 'class', 'interface', 'variable'];
        }

        return {
            intent,
            extractedSymbols,
            suggestedSymbolTypes
        };
    }

    /**
     * Convert vector store results to SearchMatch format
     */
    private convertToSearchMatches(
        results: any[],
        matchType: SearchMatch['matchType']
    ): SearchMatch[] {
        return results.map(result => ({
            id: result.id,
            content: result.content,
            filePath: result.metadata?.filePath || '',
            relativePath: result.metadata?.relativePath || '',
            startLine: result.metadata?.startLine || 0,
            endLine: result.metadata?.endLine || 0,
            language: result.metadata?.language || 'text',
            score: result.score || result.similarity || 0,
            matchType,
            symbols: (result.metadata?.symbols || []).map((name: string, index: number) => ({
                name,
                type: 'unknown',
                line: result.metadata?.startLine || 0
            })),
            imports: result.metadata?.imports || [],
            dependencies: result.metadata?.dependencies || [],
            dependents: result.metadata?.dependents || []
        }));
    }

    /**
     * Find related symbols from dependency graph
     */
    private findRelatedSymbols(
        currentSymbols: Set<string>,
        dependencyGraph: any
    ): Set<string> {
        const related = new Set<string>();

        if (dependencyGraph && dependencyGraph.edges) {
            for (const edge of dependencyGraph.edges) {
                if (currentSymbols.has(edge.source)) {
                    related.add(edge.target);
                }
                if (currentSymbols.has(edge.target)) {
                    related.add(edge.source);
                }
            }
        }

        // Remove symbols we already have
        currentSymbols.forEach(symbol => related.delete(symbol));

        return related;
    }

    /**
     * Merge and deduplicate matches from different search strategies
     */
    private mergeAndDeduplicateMatches(matches: SearchMatch[]): SearchMatch[] {
        const seen = new Map<string, SearchMatch>();

        for (const match of matches) {
            const existing = seen.get(match.id);
            if (existing) {
                // Combine scores from multiple strategies
                existing.score = Math.max(existing.score, match.score);
            } else {
                seen.set(match.id, match);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Identify relationships between matches
     */
    private identifyRelatedMatches(matches: SearchMatch[]): void {
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            match.relatedMatches = [];

            for (let j = 0; j < matches.length; j++) {
                if (i === j) continue;
                
                const other = matches[j];
                
                // Check if they share symbols, dependencies, or are in related files
                const hasSharedSymbols = match.symbols.some(s1 =>
                    other.symbols.some(s2 => s1.name === s2.name)
                );
                
                const hasSharedDependencies = match.dependencies.some(dep =>
                    other.dependencies.includes(dep) || 
                    other.dependents.includes(dep)
                );

                if (hasSharedSymbols || hasSharedDependencies) {
                    match.relatedMatches!.push(other.id);
                }
            }
        }
    }

    /**
     * Generate search suggestions
     */
    private async generateSuggestions(
        request: SearchRequest,
        matches: SearchMatch[],
        queryAnalysis: any
    ): Promise<SearchResponse['suggestions']> {
        const suggestions: SearchResponse['suggestions'] = {
            alternativeQueries: [],
            relatedSymbols: [],
            similarCodePatterns: []
        };

        // Generate alternative queries
        if (matches.length === 0) {
            suggestions.alternativeQueries = [
                `"${request.query}" implementation`,
                `${request.query} usage`,
                `${request.query} examples`
            ];
        } else if (queryAnalysis.extractedSymbols.length > 0) {
            const symbol = queryAnalysis.extractedSymbols[0];
            suggestions.alternativeQueries = [
                `${symbol} definition`,
                `${symbol} usage examples`,
                `classes that use ${symbol}`
            ];
        }

        // Collect related symbols from matches
        const symbolFreq = new Map<string, number>();
        for (const match of matches) {
            for (const symbol of match.symbols) {
                const count = symbolFreq.get(symbol.name) || 0;
                symbolFreq.set(symbol.name, count + 1);
            }
        }

        suggestions.relatedSymbols = Array.from(symbolFreq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([symbol]) => symbol);

        return suggestions;
    }

    // Utility methods
    private generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 8)}`;
    }
}
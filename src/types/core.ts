/**
 * Core types for the intelligent context MCP system
 */

export interface IndexingRequest {
    codebasePath: string;
    forceReindex?: boolean;
    incrementalMode?: boolean;
    maxFiles?: number;
    excludePatterns?: string[];
    enableDependencyAnalysis?: boolean;
    enableContentFiltering?: boolean;
    maxChunkSize?: number;
    maxChunkLines?: number;
    supportedLanguages?: string[];
}

export interface IndexingResult {
    success: boolean;
    namespace: string;
    filesProcessed: number;
    chunksCreated: number;
    processingTimeMs: number;
    incrementalUpdate: boolean;
    chunks: CodeChunk[];
    message?: string;
}

export interface SearchRequest {
    query: string;
    namespace: string;
    maxResults?: number;
    includeSymbols?: boolean;
    expandDependencies?: boolean;
    searchType?: 'semantic' | 'hybrid' | 'structural';
}

export interface SearchResponse {
    success: boolean;
    results: SearchResult[];
    totalResults: number;
    searchTime: number;
    searchTimeMs: number;
    strategy: string;
    message: string;
    metadata?: {
        vectorResults?: number;
        bm25Results?: number;
        totalMatches?: number;
        reranked?: boolean;
    };
}

export interface SearchResult {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbols: string[];
    score: number;
    context?: string;
    similarity?: number;
    connections?: {
        imports: string[];
        exports: string[];
        relatedFiles: string[];
    };
}

export interface CodeChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbols?: SymbolInfo[];
    imports?: ImportInfo[];
    exports?: string[];
    dependencies?: string[];
    score?: number;
    connections?: any;
}

export interface SymbolInfo {
    name: string;
    type: 'function' | 'class' | 'interface' | 'variable' | 'constant' | 'type' | 'namespace';
    startLine: number;
    endLine: number;
    scope?: string;
}

export interface ImportInfo {
    module: string;
    symbols: string[];
    line: number;
    isDefault?: boolean;
    isNamespace?: boolean;
    source?: string;
}

export interface ExportInfo {
    symbol: string;
    isDefault: boolean;
    startLine: number;
}

export interface FileMetadata {
    filePath: string;
    relativePath: string;
    language: string;
    size: number;
    lastModified: Date;
    contentHash: string;
    symbols: SymbolInfo[];
    imports: ImportInfo[];
    exports: string[];
}

export interface DependencyGraph {
    nodes: DependencyNode[];
    edges: DependencyEdge[];
}

export interface DependencyNode {
    id: string;
    filePath: string;
    type: 'file' | 'symbol' | 'module';
    metadata: any;
}

export interface DependencyEdge {
    from: string;
    to: string;
    type: 'imports' | 'calls' | 'extends' | 'implements';
    weight: number;
}

export interface FilterResult {
    include: boolean;
    reason?: string;
    score?: number;
}

export interface LanguageDetectionResult {
    language: string;
    confidence: number;
    extension: string;
}

export interface FileStats {
    size: number;
    modified: Date;
    created: Date;
    isDirectory: boolean;
}
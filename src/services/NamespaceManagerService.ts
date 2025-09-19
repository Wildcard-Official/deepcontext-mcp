/**
 * Namespace Manager Service
 * Handles namespace generation, indexed codebase management, and persistence
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

import { Logger } from '../utils/Logger.js';

export interface IndexedCodebase {
    path: string;
    namespace: string;
    totalChunks: number;
    indexedAt: string;
    failed?: boolean;
    failureReason?: string;
}

export interface CodebaseOperations {
    clearNamespace(namespace: string): Promise<void>;
}

export interface NamespaceInfo {
    namespace: string;
    codebasePath: string;
    totalChunks: number;
    indexedAt: Date;
}

export class NamespaceManagerService {
    private logger: Logger;
    private indexedCodebases: Map<string, IndexedCodebase> = new Map();

    constructor(
        private codebaseOperations: CodebaseOperations,
        loggerName: string = 'NamespaceManagerService'
    ) {
        this.logger = new Logger(loggerName);
    }

    /**
     * Generate a namespace from a codebase path
     */
    generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath) + (process.env.WILDCARD_API_KEY ?? '');
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 16)}`;
    }

    /**
     * Register a new indexed codebase
     */
    async registerCodebase(
        codebasePath: string,
        totalChunks: number,
        indexedAt?: Date
    ): Promise<string> {
        const resolvedPath = path.resolve(codebasePath);
        const namespace = this.generateNamespace(resolvedPath);
        
        const indexedCodebase: IndexedCodebase = {
            path: resolvedPath,
            namespace,
            totalChunks,
            indexedAt: (indexedAt || new Date()).toISOString()
        };
        
        this.indexedCodebases.set(resolvedPath, indexedCodebase);
        await this.saveIndexedCodebases();
        
        this.logger.info(`📝 Registered codebase: ${resolvedPath} -> ${namespace} (${totalChunks} chunks)`);
        return namespace;
    }

    /**
     * Register a failed indexing attempt
     */
    async registerFailedIndexing(
        codebasePath: string,
        failureReason: string,
        indexedAt?: Date
    ): Promise<string> {
        const resolvedPath = path.resolve(codebasePath);
        const namespace = this.generateNamespace(resolvedPath);

        const failedCodebase: IndexedCodebase = {
            path: resolvedPath,
            namespace,
            totalChunks: 0,
            indexedAt: (indexedAt || new Date()).toISOString(),
            failed: true,
            failureReason
        };

        this.indexedCodebases.set(resolvedPath, failedCodebase);
        await this.saveIndexedCodebases();
        this.logger.warn(`⚠️ Registered failed indexing: ${resolvedPath} - ${failureReason}`);

        return namespace;
    }

    /**
     * Get namespace for a codebase path
     */
    getNamespaceForCodebase(codebasePath: string): string | null {
        const resolvedPath = path.resolve(codebasePath);
        const indexed = this.indexedCodebases.get(resolvedPath);
        return indexed ? indexed.namespace : null;
    }

    /**
     * Get indexed codebase information
     */
    getIndexedCodebase(codebasePath: string): IndexedCodebase | null {
        const resolvedPath = path.resolve(codebasePath);
        return this.indexedCodebases.get(resolvedPath) || null;
    }

    /**
     * Check if a codebase is indexed
     */
    isCodebaseIndexed(codebasePath: string): boolean {
        const resolvedPath = path.resolve(codebasePath);
        return this.indexedCodebases.has(resolvedPath);
    }

    /**
     * Get all indexed codebases
     */
    async getAllIndexedCodebases(): Promise<Map<string, IndexedCodebase>> {
        // Ensure registry is loaded before returning data
        if (this.indexedCodebases.size === 0) {
            await this.loadIndexedCodebases();
        }
        return new Map(this.indexedCodebases);
    }

    /**
     * Get list of indexed codebases as array
     */
    getIndexedCodebasesList(): IndexedCodebase[] {
        return Array.from(this.indexedCodebases.values());
    }

    /**
     * Find codebase path by namespace
     */
    getCodebaseByNamespace(namespace: string): string | null {
        for (const [path, indexed] of this.indexedCodebases.entries()) {
            if (indexed.namespace === namespace) {
                return path;
            }
        }
        return null;
    }

    /**
     * Get the first available indexed codebase (for default operations)
     */
    getFirstIndexedCodebase(): { path: string; indexed: IndexedCodebase } | null {
        const firstEntry = Array.from(this.indexedCodebases.entries())[0];
        return firstEntry ? { path: firstEntry[0], indexed: firstEntry[1] } : null;
    }

    /**
     * Update chunk count for an indexed codebase
     */
    async updateChunkCount(codebasePath: string, totalChunks: number): Promise<void> {
        const resolvedPath = path.resolve(codebasePath);
        const indexed = this.indexedCodebases.get(resolvedPath);
        
        if (indexed) {
            indexed.totalChunks = totalChunks;
            indexed.indexedAt = new Date().toISOString();
            await this.saveIndexedCodebases();
            this.logger.debug(`📊 Updated chunk count for ${resolvedPath}: ${totalChunks} chunks`);
        }
    }

    /**
     * Clear/remove indexed codebases
     */
    async clearIndexedCodebases(codebasePath?: string): Promise<{
        success: boolean;
        message: string;
        namespacesCleared: string[];
    }> {
        const namespacesCleared: string[] = [];
        
        try {
            if (codebasePath) {
                // Clear specific codebase
                const resolvedPath = path.resolve(codebasePath);
                const indexed = this.indexedCodebases.get(resolvedPath);
                
                if (indexed) {
                    // Clear the vector store namespace
                    await this.codebaseOperations.clearNamespace(indexed.namespace);
                    namespacesCleared.push(indexed.namespace);
                    
                    // Remove from tracking
                    this.indexedCodebases.delete(resolvedPath);
                    this.logger.info(`🗑️ Cleared codebase: ${resolvedPath} (${indexed.namespace})`);
                } else {
                    return {
                        success: false,
                        message: `Codebase not found: ${codebasePath}`,
                        namespacesCleared: []
                    };
                }
            } else {
                // Clear all codebases
                for (const indexed of this.indexedCodebases.values()) {
                    await this.codebaseOperations.clearNamespace(indexed.namespace);
                    namespacesCleared.push(indexed.namespace);
                }
                this.indexedCodebases.clear();
                this.logger.info(`🗑️ Cleared all indexed codebases (${namespacesCleared.length} namespaces)`);
            }
            
            // Save the updated state
            await this.saveIndexedCodebases();
            
            return {
                success: true,
                message: codebasePath 
                    ? `Cleared codebase: ${codebasePath}` 
                    : `Cleared all ${namespacesCleared.length} indexed codebases`,
                namespacesCleared
            };
            
        } catch (error) {
            this.logger.error('Failed to clear indexed codebases:', error);
            return {
                success: false,
                message: `Failed to clear: ${error instanceof Error ? error.message : String(error)}`,
                namespacesCleared
            };
        }
    }

    /**
     * Get namespace information with metadata
     */
    getNamespaceInfo(codebasePath: string): NamespaceInfo | null {
        const indexed = this.getIndexedCodebase(codebasePath);
        if (!indexed) return null;
        
        return {
            namespace: indexed.namespace,
            codebasePath: indexed.path,
            totalChunks: indexed.totalChunks,
            indexedAt: new Date(indexed.indexedAt)
        };
    }

    /**
     * Get all namespace information
     */
    getAllNamespaceInfo(): NamespaceInfo[] {
        return Array.from(this.indexedCodebases.values()).map(indexed => ({
            namespace: indexed.namespace,
            codebasePath: indexed.path,
            totalChunks: indexed.totalChunks,
            indexedAt: new Date(indexed.indexedAt)
        }));
    }

    /**
     * Persistence methods
     */
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
            
            this.logger.debug(`💾 Saved ${this.indexedCodebases.size} indexed codebases to disk`);
        } catch (error) {
            this.logger.warn('Failed to save indexed codebases:', error);
        }
    }

    private async loadIndexedCodebases(): Promise<void> {
        try {
            const dataPath = this.getIndexedCodebasesPath();
            console.error(`[DEBUG] Loading registry from: ${dataPath}`);
            const content = await fs.readFile(dataPath, 'utf-8');
            const data = JSON.parse(content);
            
            this.indexedCodebases = new Map(data);
            console.error(`[DEBUG] Successfully loaded ${this.indexedCodebases.size} indexed codebases`);
            this.logger.info(`📂 Loaded ${this.indexedCodebases.size} indexed codebases from disk`);
        } catch (error) {
            // No existing data, start fresh
            console.error(`[DEBUG] Failed to load registry: ${error instanceof Error ? error.message : String(error)}`);
            this.indexedCodebases = new Map();
            this.logger.info('📂 Starting with empty indexed codebases (no existing data)');
        }
    }

    /**
     * Initialize the service by loading existing data
     */
    async initialize(): Promise<void> {
        console.error(`[DEBUG] NamespaceManagerService.initialize() called`);
        await this.loadIndexedCodebases();
        console.error(`[DEBUG] NamespaceManagerService initialized with ${this.indexedCodebases.size} indexed codebases`);
        this.logger.info(`🚀 NamespaceManagerService initialized with ${this.indexedCodebases.size} indexed codebases`);
    }

    /**
     * Refresh the registry by reloading from disk (for background indexing updates)
     */
    async refreshRegistry(): Promise<void> {
        console.error(`[DEBUG] Refreshing registry from disk`);
        await this.loadIndexedCodebases();
        console.error(`[DEBUG] Registry refreshed with ${this.indexedCodebases.size} indexed codebases`);
    }

    /**
     * Get service statistics
     */
    getStatistics(): {
        totalCodebases: number;
        totalChunks: number;
        namespaces: string[];
        oldestIndexed?: Date;
        newestIndexed?: Date;
    } {
        const codebases = Array.from(this.indexedCodebases.values());
        const totalChunks = codebases.reduce((sum, cb) => sum + cb.totalChunks, 0);
        const namespaces = codebases.map(cb => cb.namespace);
        
        let oldestIndexed: Date | undefined;
        let newestIndexed: Date | undefined;
        
        if (codebases.length > 0) {
            const dates = codebases.map(cb => new Date(cb.indexedAt));
            oldestIndexed = new Date(Math.min(...dates.map(d => d.getTime())));
            newestIndexed = new Date(Math.max(...dates.map(d => d.getTime())));
        }
        
        return {
            totalCodebases: codebases.length,
            totalChunks,
            namespaces,
            oldestIndexed,
            newestIndexed
        };
    }

    /**
     * Get indexing status for codebases (compatible with IndexingOrchestrator interface)
     */
    async getIndexingStatus(codebasePath?: string): Promise<{
        indexedCodebases: IndexedCodebase[];
        currentCodebase?: IndexedCodebase;
        incrementalStats?: any;
        indexed: boolean;
        fileCount: number;
    }> {
        // Refresh registry to pick up any background indexing updates
        await this.refreshRegistry();
        
        const indexedList = Array.from(this.indexedCodebases.values());

        let currentCodebase: IndexedCodebase | undefined;
        let incrementalStats: any;

        if (codebasePath) {
            try {
                const normalizedPath = path.resolve(codebasePath);
                // Check if path exists
                const fs = await import('fs/promises');
                await fs.access(normalizedPath);
                currentCodebase = this.indexedCodebases.get(normalizedPath);
            } catch (error) {
                return {
                    indexedCodebases: indexedList,
                    indexed: false,
                    fileCount: 0
                };
            }

            if (currentCodebase) {
                incrementalStats = {
                    indexingMethod: 'full',
                    lastIndexed: currentCodebase.indexedAt
                };
            }
        }

        const indexed = codebasePath ? !!currentCodebase : indexedList.length > 0;
        const fileCount = currentCodebase?.totalChunks || indexedList.reduce((sum, cb) => sum + cb.totalChunks, 0);

        return {
            indexedCodebases: indexedList,
            currentCodebase,
            incrementalStats,
            indexed,
            fileCount
        };
    }

    /**
     * Validate namespace format
     */
    isValidNamespace(namespace: string): boolean {
        return /^mcp_[a-f0-9]{8}$/.test(namespace);
    }

    /**
     * Cleanup orphaned namespaces (namespaces not in our registry)
     */
    async cleanupOrphanedNamespaces(allNamespaces: string[]): Promise<{
        orphaned: string[];
        cleaned: number;
    }> {
        const knownNamespaces = new Set(
            Array.from(this.indexedCodebases.values()).map(cb => cb.namespace)
        );
        
        const orphaned = allNamespaces.filter(ns => 
            this.isValidNamespace(ns) && !knownNamespaces.has(ns)
        );
        
        let cleaned = 0;
        for (const orphanedNs of orphaned) {
            try {
                await this.codebaseOperations.clearNamespace(orphanedNs);
                cleaned++;
                this.logger.info(`🧹 Cleaned orphaned namespace: ${orphanedNs}`);
            } catch (error) {
                this.logger.warn(`Failed to clean orphaned namespace ${orphanedNs}:`, error);
            }
        }
        
        return { orphaned, cleaned };
    }
}
/**
 * File Processing Service
 * Handles file processing, incremental updates, atomic operations, and concurrency control
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

import { Logger } from '../utils/Logger.js';
import { FileUtils } from '../utils/FileUtils.js';
import { IndexingOrchestrator, IndexingRequest } from '../core/indexing/IndexingOrchestrator.js';
import type { CodeChunk } from '../core/indexing/IndexingOrchestrator.js';

export interface FileProcessingOptions {
    maxAgeHours?: number;
    supportedLanguages?: string[];
    enableContentFiltering?: boolean;
    enableDependencyAnalysis?: boolean;
}

export interface FileUpdateResult {
    success: boolean;
    filesProcessed: number;
    chunksCreated: number;
    chunksDeleted: number;
    processingTimeMs: number;
    message: string;
}

export interface IncrementalUpdateResult extends FileUpdateResult {
    namespace: string;
}

export interface LockResult {
    acquired: boolean;
    message: string;
}

export interface ChunkOperations {
    getChunkIdsForFile(namespace: string, filePath: string): Promise<string[]>;
    deleteChunksByIds(namespace: string, chunkIds: string[]): Promise<number>;
    uploadChunks(namespace: string, chunks: CodeChunk[]): Promise<void>;
}

export class FileProcessingService {
    private logger: Logger;
    private fileUtils: FileUtils;
    private indexingOrchestrator: IndexingOrchestrator;
    private activeOperations = new Map<string, Promise<any>>();

    constructor(
        private chunkOperations: ChunkOperations,
        loggerName: string = 'FileProcessingService'
    ) {
        this.logger = new Logger(loggerName);
        this.fileUtils = new FileUtils();
        this.indexingOrchestrator = new IndexingOrchestrator();
    }

    /**
     * Process incremental updates for a codebase
     */
    async processIncrementalUpdate(
        codebasePath: string, 
        namespace: string,
        options: FileProcessingOptions = {}
    ): Promise<IncrementalUpdateResult> {
        const normalizedPath = path.resolve(codebasePath);
        const operationKey = `incremental:${normalizedPath}`;
        
        // Check for concurrent operations using file-based locking
        const lockResult = await this.acquireLock(operationKey);
        if (!lockResult.acquired) {
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                chunksDeleted: 0,
                processingTimeMs: 0,
                message: lockResult.message
            };
        }

        const startTime = Date.now();
        
        // Create operation promise for concurrency tracking
        const operationPromise = this.performIncrementalUpdate(normalizedPath, namespace, options, startTime);
        this.activeOperations.set(operationKey, operationPromise);
        
        try {
            return await operationPromise;
        } finally {
            this.activeOperations.delete(operationKey);
            await this.releaseLock(operationKey);
        }
    }

    /**
     * Internal incremental update implementation
     */
    private async performIncrementalUpdate(
        codebasePath: string,
        namespace: string,
        options: FileProcessingOptions,
        startTime: number
    ): Promise<IncrementalUpdateResult> {
        try {
            // Validate path exists and is accessible
            await fs.access(codebasePath);
            
            this.logger.info(`🔄 Starting incremental update for: ${codebasePath}`);
            
            // Get last indexed time, or default to maxAgeHours ago
            const maxAgeHours = options.maxAgeHours || 24;
            const lastIndexedTime = await this.getLastIndexedTime(codebasePath);
            const cutoffTime = lastIndexedTime || new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
            
            this.logger.info(`📅 Looking for files modified since: ${cutoffTime.toISOString()}`);
            
            // Find changed files using filesystem check
            const changedFiles = await this.findChangedFiles(codebasePath, cutoffTime, options);
            
            if (changedFiles.length === 0) {
                this.logger.info('⚡ No files need updating');
                return {
                    success: true,
                    namespace,
                    filesProcessed: 0,
                    chunksCreated: 0,
                    chunksDeleted: 0,
                    processingTimeMs: Date.now() - startTime,
                    message: 'No files modified since last indexing'
                };
            }
            
            this.logger.info(`📝 Processing ${changedFiles.length} modified files`);
            
            // Process each changed file atomically
            let totalChunksDeleted = 0;
            let totalChunksCreated = 0;
            let filesProcessed = 0;
            
            for (const filePath of changedFiles) {
                try {
                    const result = await this.updateFileAtomically(namespace, filePath, codebasePath, options);
                    totalChunksDeleted += result.chunksDeleted;
                    totalChunksCreated += result.chunksCreated;
                    filesProcessed++;
                } catch (error) {
                    this.logger.error(`❌ Failed to update ${filePath}: ${error}`);
                    // Continue with other files rather than failing completely
                }
            }
            
            // Update last indexed timestamp
            await this.saveLastIndexedTime(codebasePath, new Date());
            
            const processingTime = Date.now() - startTime;
            
            this.logger.info(`✅ Incremental update complete: ${filesProcessed}/${changedFiles.length} files (${totalChunksDeleted} deleted, ${totalChunksCreated} created chunks) in ${processingTime}ms`);
            
            return {
                success: true,
                namespace,
                filesProcessed,
                chunksCreated: totalChunksCreated,
                chunksDeleted: totalChunksDeleted,
                processingTimeMs: processingTime,
                message: `Incrementally updated ${filesProcessed} files (${totalChunksDeleted} chunks deleted, ${totalChunksCreated} chunks created)`
            };
            
        } catch (error) {
            this.logger.error('❌ Incremental update failed:', error);
            return {
                success: false,
                namespace: '',
                filesProcessed: 0,
                chunksCreated: 0,
                chunksDeleted: 0,
                processingTimeMs: Date.now() - startTime,
                message: `Incremental update failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Atomically update a single file with rollback capability
     */
    private async updateFileAtomically(
        namespace: string, 
        filePath: string, 
        codebasePath: string,
        options: FileProcessingOptions = {}
    ): Promise<{ chunksCreated: number; chunksDeleted: number }> {
        const relativePath = path.relative(codebasePath, filePath);
        this.logger.debug(`🔄 Atomically updating file: ${relativePath}`);

        // Step 1: Query existing chunks for rollback capability
        const existingChunkIds = await this.chunkOperations.getChunkIdsForFile(namespace, filePath);
        
        // Step 2: Process the file to get new chunks
        const newChunks = await this.processSingleFile(filePath, codebasePath, options);
        
        // Step 3: Upload new chunks BEFORE deleting old ones (safer)
        let chunksCreated = 0;
        if (newChunks.length > 0) {
            try {
                await this.chunkOperations.uploadChunks(namespace, newChunks);
                chunksCreated = newChunks.length;
                this.logger.debug(`✅ Uploaded ${newChunks.length} new chunks for ${relativePath}`);
            } catch (uploadError) {
                // If upload fails, we haven't deleted anything yet, so we're safe
                throw new Error(`Failed to upload new chunks: ${uploadError}`);
            }
        }

        // Step 4: Delete old chunks only after successful upload
        let chunksDeleted = 0;
        if (existingChunkIds.length > 0) {
            try {
                chunksDeleted = await this.chunkOperations.deleteChunksByIds(namespace, existingChunkIds);
                this.logger.debug(`✅ Deleted ${chunksDeleted} old chunks for ${relativePath}`);
            } catch (deleteError) {
                // Upload succeeded but delete failed - log warning but don't fail
                // This leaves some orphaned chunks but maintains functionality
                this.logger.warn(`⚠️ Failed to delete old chunks for ${relativePath}: ${deleteError}`);
                this.logger.warn(`⚠️ New chunks uploaded successfully, but old chunks remain (orphaned)`);
            }
        }

        this.logger.debug(`✅ Atomically updated ${relativePath}: ${chunksDeleted} deleted, ${chunksCreated} created`);
        return { chunksCreated, chunksDeleted };
    }

    /**
     * Process a single file to extract code chunks
     */
    private async processSingleFile(
        filePath: string, 
        codebasePath: string, 
        options: FileProcessingOptions = {}
    ): Promise<CodeChunk[]> {
        try {
            // Create a minimal IndexingRequest for single file processing
            const indexingRequest: IndexingRequest = {
                codebasePath,
                force: false,
                enableContentFiltering: options.enableContentFiltering !== false,
                enableDependencyAnalysis: options.enableDependencyAnalysis !== false
            };

            // Use the IndexingOrchestrator to process the file
            const chunks = await this.indexingOrchestrator.processFile(filePath, indexingRequest);
            
            this.logger.debug(`Processed single file ${filePath}: ${chunks.length} chunks`);
            return chunks;

        } catch (error) {
            this.logger.error(`Error processing single file ${filePath}:`, error);
            return [];
        }
    }

    /**
     * Find files modified since a given timestamp
     */
    async findChangedFiles(
        codebasePath: string, 
        since: Date, 
        options: FileProcessingOptions = {}
    ): Promise<string[]> {
        try {
            // Use FileUtils to discover all code files
            const supportedLanguages = options.supportedLanguages || 
                ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust'];
            
            const allFiles = await this.fileUtils.discoverFiles(codebasePath, supportedLanguages);
            
            const changedFiles: string[] = [];
            
            for (const filePath of allFiles) {
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.mtime > since) {
                        changedFiles.push(filePath);
                    }
                } catch (error) {
                    // File might have been deleted, skip it
                    continue;
                }
            }
            
            return changedFiles;
        } catch (error) {
            this.logger.error('Error finding changed files:', error);
            return [];
        }
    }

    /**
     * File-based concurrency control
     */
    private getLockFilePath(operationKey: string): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        const safeKey = operationKey.replace(/[^a-zA-Z0-9-_]/g, '_');
        return path.join(dataDir, `${safeKey}.lock`);
    }

    private async acquireLock(operationKey: string): Promise<LockResult> {
        const lockFilePath = this.getLockFilePath(operationKey);
        
        try {
            // Ensure directory exists
            await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
            
            // Try to create lock file exclusively (fails if exists)
            await fs.writeFile(lockFilePath, JSON.stringify({
                operation: operationKey,
                pid: process.pid,
                startTime: new Date().toISOString()
            }), { flag: 'wx' }); // 'wx' = create exclusive, fail if exists
            
            return { acquired: true, message: 'Lock acquired successfully' };
            
        } catch (error: any) {
            if (error.code === 'EEXIST') {
                // Lock file exists - check if it's stale
                try {
                    const lockContent = await fs.readFile(lockFilePath, 'utf-8');
                    const lockData = JSON.parse(lockContent);
                    const lockTime = new Date(lockData.startTime);
                    const now = new Date();
                    const ageMinutes = (now.getTime() - lockTime.getTime()) / (1000 * 60);
                    
                    if (ageMinutes > 30) { // Consider locks older than 30 minutes as stale
                        this.logger.warn(`Removing stale lock file (${ageMinutes.toFixed(1)} minutes old): ${lockFilePath}`);
                        await fs.unlink(lockFilePath);
                        // Try to acquire lock again
                        return await this.acquireLock(operationKey);
                    } else {
                        return { 
                            acquired: false, 
                            message: `Operation already in progress (started ${ageMinutes.toFixed(1)} minutes ago)` 
                        };
                    }
                } catch (readError) {
                    // Corrupt lock file - remove and retry
                    try {
                        await fs.unlink(lockFilePath);
                        return await this.acquireLock(operationKey);
                    } catch (unlinkError) {
                        return { 
                            acquired: false, 
                            message: 'Failed to acquire lock due to file system issue' 
                        };
                    }
                }
            } else {
                return { 
                    acquired: false, 
                    message: `Failed to acquire lock: ${error.message}` 
                };
            }
        }
    }

    private async releaseLock(operationKey: string): Promise<void> {
        const lockFilePath = this.getLockFilePath(operationKey);
        
        try {
            await fs.unlink(lockFilePath);
            this.logger.debug(`Released lock: ${operationKey}`);
        } catch (error: any) {
            // Lock file might not exist or be already deleted - that's OK
            this.logger.debug(`Lock release no-op (file not found): ${operationKey}`);
        }
    }

    /**
     * Timestamp management for incremental updates
     */
    private getLastIndexedTimestampPath(codebasePath: string): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        // Generate a simple hash of the path for the filename
        const pathHash = crypto.createHash('md5').update(codebasePath).digest('hex').substring(0, 8);
        return path.join(dataDir, `${pathHash}-last-indexed.txt`);
    }

    async getLastIndexedTime(codebasePath: string): Promise<Date | null> {
        try {
            const timestampPath = this.getLastIndexedTimestampPath(codebasePath);
            const content = await fs.readFile(timestampPath, 'utf-8');
            return new Date(content.trim());
        } catch (error) {
            // No timestamp file exists yet
            return null;
        }
    }

    async saveLastIndexedTime(codebasePath: string, timestamp: Date): Promise<void> {
        try {
            const timestampPath = this.getLastIndexedTimestampPath(codebasePath);
            const dir = path.dirname(timestampPath);
            
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(timestampPath, timestamp.toISOString(), 'utf-8');
        } catch (error) {
            this.logger.warn('Failed to save last indexed timestamp:', error);
        }
    }

    /**
     * Check if there are any active operations
     */
    hasActiveOperations(): boolean {
        return this.activeOperations.size > 0;
    }

    /**
     * Get list of active operation keys
     */
    getActiveOperations(): string[] {
        return Array.from(this.activeOperations.keys());
    }

    /**
     * Get service status
     */
    getStatus(): {
        activeOperations: number;
        operationKeys: string[];
    } {
        return {
            activeOperations: this.activeOperations.size,
            operationKeys: this.getActiveOperations()
        };
    }
}
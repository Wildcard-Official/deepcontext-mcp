/**
 * File Processing Service
 * Handles file processing, incremental updates, atomic operations, and concurrency control
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

import { Logger } from '../utils/Logger.js';
import { FileUtils } from '../utils/FileUtils.js';
import { IndexingOrchestrator } from '../core/indexing/IndexingOrchestrator.js';
import { CodeChunk, IndexingRequest } from '../types/core.js';
import { LockService } from './LockService.js';

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

export interface FileMetadata {
    filePath: string;
    lastModified: Date;
    size: number;
    contentHash: string;
    chunkIds: string[];
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
    private lockService: LockService;
    private activeOperations = new Map<string, Promise<any>>();
    private fileMetadataCache = new Map<string, Map<string, FileMetadata>>(); // codebasePath -> file metadata

    constructor(
        private chunkOperations: ChunkOperations,
        loggerName: string = 'FileProcessingService'
    ) {
        this.logger = new Logger(loggerName);
        this.fileUtils = new FileUtils();
        this.indexingOrchestrator = new IndexingOrchestrator();
        this.lockService = new LockService(`${loggerName}-LOCK`);
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
        const lockResult = await this.lockService.acquireLock(operationKey);
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
            await this.lockService.releaseLock(operationKey);
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

            // Batch save all file metadata after processing all files
            if (filesProcessed > 0) {
                this.logger.debug(`💾 Batch saving metadata for ${filesProcessed} processed files`);
                await this.saveFileMetadata(codebasePath);
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

        // Step 1: Query existing chunks for rollback capability
        // Chunks are stored with filePath that includes the codebase directory name
        const codebaseDirectoryName = path.basename(codebasePath);
        const chunkFilePath = `${codebaseDirectoryName}/${relativePath}`;
        const existingChunkIds = await this.chunkOperations.getChunkIdsForFile(namespace, chunkFilePath);
        
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

        // Update file metadata after successful processing
        await this.updateFileMetadata(codebasePath, filePath, newChunks.map(chunk => chunk.id));

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
                forceReindex: false,
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
     * Find files modified since a specific time with optional hash verification
     */
    async findChangedFiles(
        codebasePath: string,
        since: Date,
        options: FileProcessingOptions = {}
    ): Promise<string[]> {
        try {
            // Load file metadata for this codebase
            await this.loadFileMetadata(codebasePath);

            // Use FileUtils to discover all code files
            const supportedLanguages = options.supportedLanguages ||
                ['typescript', 'javascript', 'python', 'java', 'cpp', 'go', 'rust'];

            const allFiles = await this.fileUtils.discoverFiles(codebasePath, supportedLanguages);
            const changedFiles: string[] = [];

            for (const filePath of allFiles) {
                try {
                    if (await this.isFileModifiedSince(codebasePath, filePath, since)) {
                        changedFiles.push(filePath);
                    }
                } catch (error) {
                    // If we can't check, assume it's changed
                    this.logger.debug(`Error checking file ${filePath}, assuming changed:`, error);
                    changedFiles.push(filePath);
                }
            }

            this.logger.debug(`Found ${changedFiles.length} changed files out of ${allFiles.length} total files (modified since ${since.toISOString()})`);
            return changedFiles;
        } catch (error) {
            this.logger.error('Error finding changed files:', error);
            return [];
        }
    }


    /**
     * Check if file was modified since a specific date (time-based with hash verification)
     */
    private async isFileModifiedSince(codebasePath: string, filePath: string, since: Date): Promise<boolean> {
        try {
            const stats = await fs.stat(filePath);

            // First check: file modification time vs cutoff time
            if (stats.mtime <= since) {
                return false; // File hasn't been modified since cutoff
            }

            // File was modified after cutoff - check if content actually changed
            const metadata = this.getFileMetadata(codebasePath, filePath);

            if (!metadata) {
                // File not tracked yet, consider it modified
                return true;
            }

            // Quick check: file size
            if (stats.size !== metadata.size) {
                return true;
            }

            // Accurate check: content hash (only if size matches)
            const content = await fs.readFile(filePath, 'utf-8');
            const currentHash = this.calculateContentHash(content);

            return currentHash !== metadata.contentHash;

        } catch (error) {
            // File might not exist or be readable, assume it's changed
            return true;
        }
    }


    private calculateContentHash(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
    }

    private getFileMetadata(codebasePath: string, filePath: string): FileMetadata | undefined {
        const codebaseMetadata = this.fileMetadataCache.get(codebasePath);
        return codebaseMetadata?.get(filePath);
    }

    private setFileMetadata(codebasePath: string, filePath: string, metadata: FileMetadata): void {
        if (!this.fileMetadataCache.has(codebasePath)) {
            this.fileMetadataCache.set(codebasePath, new Map());
        }
        this.fileMetadataCache.get(codebasePath)!.set(filePath, metadata);
    }

    private getFileMetadataPath(codebasePath: string): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        const pathHash = crypto.createHash('md5').update(codebasePath).digest('hex').substring(0, 8);
        return path.join(dataDir, `${pathHash}-file-metadata.json`);
    }

    private async loadFileMetadata(codebasePath: string): Promise<void> {
        if (this.fileMetadataCache.has(codebasePath)) {
            return; // Already loaded
        }

        const metadataPath = this.getFileMetadataPath(codebasePath);

        try {
            const content = await fs.readFile(metadataPath, 'utf-8');
            const data = JSON.parse(content);

            const fileMetadata = new Map<string, FileMetadata>();
            if (Array.isArray(data)) {
                for (const [filePath, metadata] of data) {
                    // Convert date string back to Date object
                    if (metadata.lastModified) {
                        metadata.lastModified = new Date(metadata.lastModified);
                    }
                    fileMetadata.set(filePath, metadata);
                }
            }

            this.fileMetadataCache.set(codebasePath, fileMetadata);
        } catch (error) {
            // No existing metadata or error reading, start fresh
            this.fileMetadataCache.set(codebasePath, new Map());
        }
    }

    private async saveFileMetadata(codebasePath: string): Promise<void> {
        const metadataPath = this.getFileMetadataPath(codebasePath);
        const metadata = this.fileMetadataCache.get(codebasePath);

        if (!metadata) return;

        try {
            // Ensure directory exists
            await fs.mkdir(path.dirname(metadataPath), { recursive: true });

            // Convert Map to array for JSON serialization
            const data = Array.from(metadata.entries());
            const content = JSON.stringify(data, null, 2);

            await fs.writeFile(metadataPath, content, 'utf-8');
        } catch (error) {
            this.logger.warn('Failed to save file metadata:', error);
        }
    }

    async updateFileMetadata(codebasePath: string, filePath: string, chunkIds: string[]): Promise<void> {
        try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf-8');

            const metadata: FileMetadata = {
                filePath,
                lastModified: stats.mtime,
                size: stats.size,
                contentHash: this.calculateContentHash(content),
                chunkIds
            };

            this.setFileMetadata(codebasePath, filePath, metadata);
            // Note: Don't save to disk here - batch save after all files processed
        } catch (error) {
            this.logger.debug(`Failed to update metadata for ${filePath}:`, error);
        }
    }

    async updateFileMetadataAndSave(codebasePath: string, filePath: string, chunkIds: string[]): Promise<void> {
        await this.updateFileMetadata(codebasePath, filePath, chunkIds);
        await this.saveFileMetadata(codebasePath);
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
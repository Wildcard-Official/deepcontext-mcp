/**
 * IncrementalIndexer - Intelligent incremental indexing for fast updates
 * 
 * Tracks file changes and only re-indexes what's necessary:
 * - File modification time tracking
 * - Content hash comparison
 * - Dependency change propagation
 * - Efficient chunk updates
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileUtils } from '../../utils/FileUtils.js';

export interface FileMetadata {
    filePath: string;
    relativePath: string;
    lastModified: Date;
    size: number;
    contentHash: string;
    chunkIds: string[];
    symbols: string[];
    imports: string[];
    dependsOn: string[];  // Files this file depends on
    dependents: string[]; // Files that depend on this file
}

export interface IndexMetadata {
    codebasePath: string;
    namespace: string;
    lastIndexed: Date;
    totalFiles: number;
    totalChunks: number;
    indexingMethod: 'full' | 'incremental';
    fileMetadata: Map<string, FileMetadata>;
    version: string;
}

export interface ChangeSet {
    newFiles: string[];
    modifiedFiles: string[];
    deletedFiles: string[];
    unchangedFiles: string[];
    dependencyChanges: string[]; // Files affected by dependency changes
}

export class IncrementalIndexer {
    private fileUtils: FileUtils;
    private readonly METADATA_VERSION = '1.0.0';

    constructor() {
        this.fileUtils = new FileUtils();
    }

    /**
     * Check if codebase has existing index
     */
    async hasExistingIndex(codebasePath: string): Promise<boolean> {
        const metadataPath = this.getMetadataPath(codebasePath);
        try {
            await fs.access(metadataPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get files that need to be updated for incremental indexing
     */
    async getFilesToUpdate(
        currentFiles: string[],
        codebasePath: string
    ): Promise<string[]> {
        const changes = await this.detectChanges(currentFiles, codebasePath);
        
        // Combine files that need updating
        const filesToUpdate = [
            ...changes.newFiles,
            ...changes.modifiedFiles,
            ...changes.dependencyChanges
        ];

        console.log(`[INCREMENTAL] 📊 Change summary:
  - New files: ${changes.newFiles.length}
  - Modified files: ${changes.modifiedFiles.length}  
  - Deleted files: ${changes.deletedFiles.length}
  - Dependency changes: ${changes.dependencyChanges.length}
  - Unchanged files: ${changes.unchangedFiles.length}`);

        return [...new Set(filesToUpdate)]; // Remove duplicates
    }

    /**
     * Detect changes since last indexing
     */
    async detectChanges(
        currentFiles: string[],
        codebasePath: string
    ): Promise<ChangeSet> {
        const existingMetadata = await this.loadIndexMetadata(codebasePath);
        
        if (!existingMetadata) {
            // No existing index, all files are new
            return {
                newFiles: currentFiles,
                modifiedFiles: [],
                deletedFiles: [],
                unchangedFiles: [],
                dependencyChanges: []
            };
        }

        const existingFiles = new Map<string, FileMetadata>();
        for (const [filePath, metadata] of existingMetadata.fileMetadata) {
            existingFiles.set(filePath, metadata);
        }

        const currentFileSet = new Set(currentFiles);
        const existingFileSet = new Set(existingFiles.keys());

        // Categorize files
        const newFiles: string[] = [];
        const modifiedFiles: string[] = [];
        const unchangedFiles: string[] = [];

        // Check each current file
        for (const filePath of currentFiles) {
            if (!existingFileSet.has(filePath)) {
                newFiles.push(filePath);
            } else {
                const isModified = await this.isFileModified(filePath, existingFiles.get(filePath)!);
                if (isModified) {
                    modifiedFiles.push(filePath);
                } else {
                    unchangedFiles.push(filePath);
                }
            }
        }

        // Find deleted files
        const deletedFiles = Array.from(existingFileSet).filter(f => !currentFileSet.has(f));

        // Find files affected by dependency changes
        const dependencyChanges = await this.findDependencyChanges(
            [...newFiles, ...modifiedFiles, ...deletedFiles],
            existingMetadata
        );

        return {
            newFiles,
            modifiedFiles,
            deletedFiles,
            unchangedFiles,
            dependencyChanges
        };
    }

    /**
     * Check if a file has been modified since last indexing
     */
    private async isFileModified(filePath: string, metadata: FileMetadata): Promise<boolean> {
        try {
            const stats = await this.fileUtils.getFileStats(filePath);
            if (!stats) return true; // File doesn't exist anymore

            // Check modification time
            if (stats.modified > metadata.lastModified) {
                return true;
            }

            // Check file size
            if (stats.size !== metadata.size) {
                return true;
            }

            // For extra accuracy, check content hash for recently modified files
            const timeDiff = Date.now() - metadata.lastModified.getTime();
            if (timeDiff < 24 * 60 * 60 * 1000) { // Within last 24 hours
                const content = await this.fileUtils.readFileContent(filePath);
                if (content) {
                    const currentHash = this.calculateContentHash(content);
                    if (currentHash !== metadata.contentHash) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error) {
            console.warn(`[INCREMENTAL] Error checking file ${filePath}: ${error}`);
            return true; // Assume modified if we can't check
        }
    }

    /**
     * Find files affected by dependency changes
     */
    private async findDependencyChanges(
        changedFiles: string[],
        indexMetadata: IndexMetadata
    ): Promise<string[]> {
        const affectedFiles = new Set<string>();

        for (const changedFile of changedFiles) {
            const metadata = indexMetadata.fileMetadata.get(changedFile);
            if (metadata) {
                // If this file changed, all its dependents might be affected
                for (const dependent of metadata.dependents) {
                    affectedFiles.add(dependent);
                }

                // If this file was deleted, remove it from its dependencies' dependents
                for (const dependency of metadata.dependsOn) {
                    const depMetadata = indexMetadata.fileMetadata.get(dependency);
                    if (depMetadata) {
                        const updatedDependents = depMetadata.dependents.filter(d => d !== changedFile);
                        if (updatedDependents.length !== depMetadata.dependents.length) {
                            affectedFiles.add(dependency);
                        }
                    }
                }
            }
        }

        // Remove files that are already in the changed list
        const changedFileSet = new Set(changedFiles);
        return Array.from(affectedFiles).filter(f => !changedFileSet.has(f));
    }

    /**
     * Update index metadata after processing files
     */
    async updateIndexMetadata(
        codebasePath: string,
        processedFiles: string[],
        chunks: any[]
    ): Promise<void> {
        let metadata = await this.loadIndexMetadata(codebasePath);
        
        if (!metadata) {
            // Create new metadata
            metadata = {
                codebasePath,
                namespace: this.generateNamespace(codebasePath),
                lastIndexed: new Date(),
                totalFiles: 0,
                totalChunks: 0,
                indexingMethod: 'full',
                fileMetadata: new Map(),
                version: this.METADATA_VERSION
            };
        }

        // Update processed files
        for (const filePath of processedFiles) {
            try {
                const stats = await this.fileUtils.getFileStats(filePath);
                const content = await this.fileUtils.readFileContent(filePath);
                
                if (stats && content) {
                    const relativePath = this.fileUtils.getRelativePath(filePath, codebasePath);
                    const contentHash = this.calculateContentHash(content);
                    
                    // Get chunks for this file
                    const fileChunks = chunks.filter(c => c.filePath === filePath);
                    const chunkIds = fileChunks.map(c => c.id);
                    
                    // Extract symbols and imports from chunks
                    const symbols = [...new Set(fileChunks.flatMap(c => c.symbols?.map((s: any) => s.name) || []))];
                    const imports = [...new Set(fileChunks.flatMap(c => c.imports?.map((i: any) => i.module) || []))];

                    metadata.fileMetadata.set(filePath, {
                        filePath,
                        relativePath,
                        lastModified: stats.modified,
                        size: stats.size,
                        contentHash,
                        chunkIds,
                        symbols,
                        imports,
                        dependsOn: [], // Will be populated by dependency analysis
                        dependents: [] // Will be populated by dependency analysis
                    });
                }
            } catch (error) {
                console.warn(`[INCREMENTAL] Error updating metadata for ${filePath}: ${error}`);
            }
        }

        // Update global metadata
        metadata.lastIndexed = new Date();
        metadata.totalFiles = metadata.fileMetadata.size;
        metadata.totalChunks = chunks.length;
        metadata.indexingMethod = 'incremental';

        // Save updated metadata
        await this.saveIndexMetadata(codebasePath, metadata);
        
        console.log(`[INCREMENTAL] ✅ Updated metadata: ${metadata.totalFiles} files, ${metadata.totalChunks} chunks`);
    }

    /**
     * Update dependency relationships in metadata
     */
    async updateDependencyRelationships(
        codebasePath: string,
        dependencyMap: Map<string, string[]>
    ): Promise<void> {
        const metadata = await this.loadIndexMetadata(codebasePath);
        if (!metadata) return;

        // Clear existing dependency relationships
        for (const fileMetadata of metadata.fileMetadata.values()) {
            fileMetadata.dependsOn = [];
            fileMetadata.dependents = [];
        }

        // Build new dependency relationships
        for (const [filePath, dependencies] of dependencyMap.entries()) {
            const fileMetadata = metadata.fileMetadata.get(filePath);
            if (fileMetadata) {
                fileMetadata.dependsOn = dependencies;
                
                // Update dependents for each dependency
                for (const depPath of dependencies) {
                    const depMetadata = metadata.fileMetadata.get(depPath);
                    if (depMetadata && !depMetadata.dependents.includes(filePath)) {
                        depMetadata.dependents.push(filePath);
                    }
                }
            }
        }

        await this.saveIndexMetadata(codebasePath, metadata);
        console.log('[INCREMENTAL] ✅ Updated dependency relationships');
    }

    /**
     * Clean up metadata for deleted files
     */
    async cleanupDeletedFiles(codebasePath: string, deletedFiles: string[]): Promise<void> {
        if (deletedFiles.length === 0) return;

        const metadata = await this.loadIndexMetadata(codebasePath);
        if (!metadata) return;

        for (const filePath of deletedFiles) {
            const fileMetadata = metadata.fileMetadata.get(filePath);
            if (fileMetadata) {
                // Remove this file from its dependencies' dependents
                for (const depPath of fileMetadata.dependsOn) {
                    const depMetadata = metadata.fileMetadata.get(depPath);
                    if (depMetadata) {
                        depMetadata.dependents = depMetadata.dependents.filter(d => d !== filePath);
                    }
                }

                // Update dependents to remove this dependency
                for (const dependentPath of fileMetadata.dependents) {
                    const dependentMetadata = metadata.fileMetadata.get(dependentPath);
                    if (dependentMetadata) {
                        dependentMetadata.dependsOn = dependentMetadata.dependsOn.filter(d => d !== filePath);
                    }
                }

                // Remove the file metadata
                metadata.fileMetadata.delete(filePath);
            }
        }

        metadata.totalFiles = metadata.fileMetadata.size;
        await this.saveIndexMetadata(codebasePath, metadata);
        
        console.log(`[INCREMENTAL] 🧹 Cleaned up ${deletedFiles.length} deleted files`);
    }

    /**
     * Load index metadata from disk
     */
    private async loadIndexMetadata(codebasePath: string): Promise<IndexMetadata | null> {
        const metadataPath = this.getMetadataPath(codebasePath);
        
        try {
            const content = await fs.readFile(metadataPath, 'utf-8');
            const data = JSON.parse(content);
            
            // Convert fileMetadata array back to Map
            const fileMetadata = new Map<string, FileMetadata>();
            if (data.fileMetadata && Array.isArray(data.fileMetadata)) {
                for (const [key, value] of data.fileMetadata) {
                    // Convert date strings back to Date objects
                    if (value.lastModified) {
                        value.lastModified = new Date(value.lastModified);
                    }
                    fileMetadata.set(key, value);
                }
            }

            return {
                ...data,
                lastIndexed: new Date(data.lastIndexed),
                fileMetadata
            };
        } catch (error) {
            console.warn(`[INCREMENTAL] Could not load metadata: ${error}`);
            return null;
        }
    }

    /**
     * Save index metadata to disk
     */
    private async saveIndexMetadata(codebasePath: string, metadata: IndexMetadata): Promise<void> {
        const metadataPath = this.getMetadataPath(codebasePath);
        
        try {
            // Ensure directory exists
            await this.fileUtils.ensureDirectory(path.dirname(metadataPath));
            
            // Convert Map to array for JSON serialization
            const serializable = {
                ...metadata,
                fileMetadata: Array.from(metadata.fileMetadata.entries())
            };
            
            const content = JSON.stringify(serializable, null, 2);
            await fs.writeFile(metadataPath, content, 'utf-8');
        } catch (error) {
            console.error(`[INCREMENTAL] Failed to save metadata: ${error}`);
            throw error;
        }
    }

    /**
     * Get statistics about the incremental index
     */
    async getIndexStats(codebasePath: string): Promise<{
        hasIndex: boolean;
        totalFiles: number;
        totalChunks: number;
        lastIndexed: Date | null;
        indexingMethod: string;
        oldestFile: Date | null;
        newestFile: Date | null;
    }> {
        const metadata = await this.loadIndexMetadata(codebasePath);
        
        if (!metadata) {
            return {
                hasIndex: false,
                totalFiles: 0,
                totalChunks: 0,
                lastIndexed: null,
                indexingMethod: 'none',
                oldestFile: null,
                newestFile: null
            };
        }

        let oldestFile: Date | null = null;
        let newestFile: Date | null = null;

        for (const fileMetadata of metadata.fileMetadata.values()) {
            if (!oldestFile || fileMetadata.lastModified < oldestFile) {
                oldestFile = fileMetadata.lastModified;
            }
            if (!newestFile || fileMetadata.lastModified > newestFile) {
                newestFile = fileMetadata.lastModified;
            }
        }

        return {
            hasIndex: true,
            totalFiles: metadata.totalFiles,
            totalChunks: metadata.totalChunks,
            lastIndexed: metadata.lastIndexed,
            indexingMethod: metadata.indexingMethod,
            oldestFile,
            newestFile
        };
    }

    // Utility methods
    private getMetadataPath(codebasePath: string): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        const namespace = this.generateNamespace(codebasePath);
        return path.join(dataDir, `${namespace}-incremental.json`);
    }

    private generateNamespace(codebasePath: string): string {
        const normalized = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return `mcp_${hash.substring(0, 8)}`;
    }

    private calculateContentHash(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
    }

    /**
     * Force full re-indexing by removing incremental metadata
     */
    async forceFullReindex(codebasePath: string): Promise<void> {
        const metadataPath = this.getMetadataPath(codebasePath);
        try {
            await fs.unlink(metadataPath);
            console.log('[INCREMENTAL] 🔄 Forced full re-indexing by removing incremental metadata');
        } catch (error) {
            // File doesn't exist, which is fine
            console.log('[INCREMENTAL] No incremental metadata to remove');
        }
    }

    /**
     * Optimize metadata by removing orphaned entries
     */
    async optimizeMetadata(codebasePath: string): Promise<void> {
        const metadata = await this.loadIndexMetadata(codebasePath);
        if (!metadata) return;

        let removed = 0;
        const filesToRemove: string[] = [];

        for (const [filePath, fileMetadata] of metadata.fileMetadata.entries()) {
            try {
                // Check if file still exists
                await fs.access(filePath);
            } catch {
                // File doesn't exist, mark for removal
                filesToRemove.push(filePath);
                removed++;
            }
        }

        if (removed > 0) {
            await this.cleanupDeletedFiles(codebasePath, filesToRemove);
            console.log(`[INCREMENTAL] 🧹 Optimized metadata: removed ${removed} orphaned entries`);
        }
    }
}
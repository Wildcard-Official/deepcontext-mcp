/**
 * Lock Service - File-based concurrency control
 * Extracted from FileProcessingService to be reusable across the MCP
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils/Logger.js';

export interface LockResult {
    acquired: boolean;
    message: string;
}

export class LockService {
    private logger: Logger;

    constructor(loggerName: string = 'LockService') {
        this.logger = new Logger(loggerName);
    }

    /**
     * Generate lock file path for an operation
     */
    private getLockFilePath(operationKey: string): string {
        const dataDir = process.env.CODEX_CONTEXT_DATA_DIR || path.join(process.env.HOME || '~', '.codex-context');
        const safeKey = operationKey.replace(/[^a-zA-Z0-9-_]/g, '_');
        return path.join(dataDir, `${safeKey}.lock`);
    }

    /**
     * Acquire a lock for an operation
     */
    async acquireLock(operationKey: string): Promise<LockResult> {
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

    /**
     * Release a lock for an operation
     */
    async releaseLock(operationKey: string): Promise<void> {
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
     * Check if a lock exists for an operation
     */
    async isLocked(operationKey: string): Promise<boolean> {
        const lockFilePath = this.getLockFilePath(operationKey);

        try {
            await fs.access(lockFilePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get lock information for an operation
     */
    async getLockInfo(operationKey: string): Promise<{
        locked: boolean;
        operation?: string;
        pid?: number;
        startTime?: string;
        ageMinutes?: number;
    }> {
        const lockFilePath = this.getLockFilePath(operationKey);

        try {
            const lockContent = await fs.readFile(lockFilePath, 'utf-8');
            const lockData = JSON.parse(lockContent);
            const lockTime = new Date(lockData.startTime);
            const now = new Date();
            const ageMinutes = (now.getTime() - lockTime.getTime()) / (1000 * 60);

            return {
                locked: true,
                operation: lockData.operation,
                pid: lockData.pid,
                startTime: lockData.startTime,
                ageMinutes
            };
        } catch {
            return { locked: false };
        }
    }
}
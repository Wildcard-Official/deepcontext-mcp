/**
 * FileUtils - File system operations and discovery
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export class FileUtils {
    private readonly SUPPORTED_EXTENSIONS = new Map([
        ['typescript', ['.ts', '.tsx']],
        ['javascript', ['.js', '.jsx', '.mjs', '.cjs']],
        ['python', ['.py', '.pyx', '.pyi']],
        ['java', ['.java']],
        ['cpp', ['.cpp', '.cxx', '.cc', '.c', '.h', '.hpp', '.hxx']],
        ['go', ['.go']],
        ['rust', ['.rs']],
        ['csharp', ['.cs']],
        ['php', ['.php']],
        ['ruby', ['.rb']],
        ['swift', ['.swift']],
        ['kotlin', ['.kt', '.kts']]
    ]);

    private readonly IGNORE_DIRECTORIES = new Set([
        'node_modules',
        '.git',
        '.svn',
        '.hg',
        'dist',
        'build',
        'out',
        'target',
        'bin',
        'obj',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.tox',
        'venv',
        'env',
        '.env',
        '.next',
        '.nuxt',
        'coverage',
        '.nyc_output',
        'logs',
        'tmp',
        'temp',
        '.DS_Store',
        'Thumbs.db'
    ]);

    private readonly IGNORE_FILES = new Set([
        '.gitignore',
        '.dockerignore',
        '.eslintignore',
        '.prettierignore',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'Cargo.lock',
        'Pipfile.lock',
        'poetry.lock'
    ]);

    /**
     * Discover all supported files in a codebase directory
     */
    async discoverFiles(
        codebasePath: string, 
        supportedLanguages?: string[]
    ): Promise<string[]> {
        const files: string[] = [];
        const allowedExtensions = this.getExtensionsForLanguages(supportedLanguages);
        
        await this.traverseDirectory(codebasePath, codebasePath, files, allowedExtensions);
        
        return files.sort(); // Consistent ordering
    }

    /**
     * Recursively traverse directory structure
     */
    private async traverseDirectory(
        currentPath: string,
        basePath: string,
        files: string[],
        allowedExtensions: Set<string>,
        depth: number = 0
    ): Promise<void> {
        // Prevent infinite recursion and very deep structures
        if (depth > 20) {
            console.warn(`[FileUtils] Maximum depth reached for: ${currentPath}`);
            return;
        }

        try {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                
                if (entry.isDirectory()) {
                    // Skip ignored directories
                    if (!this.IGNORE_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
                        await this.traverseDirectory(fullPath, basePath, files, allowedExtensions, depth + 1);
                    }
                } else if (entry.isFile()) {
                    // Check if file should be included
                    if (this.shouldIncludeFile(entry.name, allowedExtensions)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error) {
            console.warn(`[FileUtils] Error reading directory ${currentPath}: ${error}`);
        }
    }

    /**
     * Check if a file should be included based on extension and name
     */
    private shouldIncludeFile(fileName: string, allowedExtensions: Set<string>): boolean {
        // Skip ignored files
        if (this.IGNORE_FILES.has(fileName)) {
            return false;
        }

        // Skip hidden files and common patterns
        if (fileName.startsWith('.') || 
            fileName.endsWith('.min.js') ||
            fileName.endsWith('.map') ||
            fileName.includes('.generated.') ||
            fileName.includes('.gen.')) {
            return false;
        }

        // Check extension
        const ext = path.extname(fileName).toLowerCase();
        return allowedExtensions.has(ext);
    }

    /**
     * Get file extensions for specified languages
     */
    private getExtensionsForLanguages(languages?: string[]): Set<string> {
        if (!languages || languages.length === 0) {
            // Return all supported extensions
            const allExtensions = new Set<string>();
            for (const exts of this.SUPPORTED_EXTENSIONS.values()) {
                exts.forEach(ext => allExtensions.add(ext));
            }
            return allExtensions;
        }

        const extensions = new Set<string>();
        for (const language of languages) {
            const langExtensions = this.SUPPORTED_EXTENSIONS.get(language.toLowerCase());
            if (langExtensions) {
                langExtensions.forEach(ext => extensions.add(ext));
            }
        }
        
        return extensions;
    }

    /**
     * Get file statistics
     */
    async getFileStats(filePath: string): Promise<{
        size: number;
        modified: Date;
        created: Date;
    } | null> {
        try {
            const stats = await fs.stat(filePath);
            return {
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if file has been modified since a given timestamp
     */
    async isFileModifiedSince(filePath: string, timestamp: Date): Promise<boolean> {
        const stats = await this.getFileStats(filePath);
        return stats ? stats.modified > timestamp : true;
    }

    /**
     * Get relative path with normalized separators
     */
    getRelativePath(filePath: string, basePath: string): string {
        return path.relative(basePath, filePath).replace(/\\/g, '/');
    }

    /**
     * Ensure directory exists
     */
    async ensureDirectory(dirPath: string): Promise<void> {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            console.warn(`[FileUtils] Failed to create directory ${dirPath}: ${error}`);
        }
    }

    /**
     * Read file with error handling
     */
    async readFileContent(filePath: string): Promise<string | null> {
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch (error) {
            console.warn(`[FileUtils] Failed to read file ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Write file with directory creation
     */
    async writeFileContent(filePath: string, content: string): Promise<boolean> {
        try {
            const dir = path.dirname(filePath);
            await this.ensureDirectory(dir);
            await fs.writeFile(filePath, content, 'utf-8');
            return true;
        } catch (error) {
            console.warn(`[FileUtils] Failed to write file ${filePath}: ${error}`);
            return false;
        }
    }

    /**
     * Get supported languages for a file extension
     */
    getLanguageForExtension(extension: string): string | null {
        const normalizedExt = extension.toLowerCase();
        
        for (const [language, extensions] of this.SUPPORTED_EXTENSIONS.entries()) {
            if (extensions.includes(normalizedExt)) {
                return language;
            }
        }
        
        return null;
    }

    /**
     * Get all supported languages
     */
    getSupportedLanguages(): string[] {
        return Array.from(this.SUPPORTED_EXTENSIONS.keys());
    }
}
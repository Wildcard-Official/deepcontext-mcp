/**
 * LanguageDetector - Detect programming language from file extension and content
 */

import * as path from 'path';

export interface LanguageInfo {
    language: string;
    confidence: number;
    fileType: 'source' | 'test' | 'config' | 'documentation' | 'data';
}

export class LanguageDetector {
    private readonly EXTENSION_MAP = new Map([
        // TypeScript
        ['.ts', { language: 'typescript', confidence: 1.0 }],
        ['.tsx', { language: 'typescript', confidence: 1.0 }],
        ['.d.ts', { language: 'typescript', confidence: 1.0 }],
        
        // JavaScript
        ['.js', { language: 'javascript', confidence: 1.0 }],
        ['.jsx', { language: 'javascript', confidence: 1.0 }],
        ['.mjs', { language: 'javascript', confidence: 1.0 }],
        ['.cjs', { language: 'javascript', confidence: 1.0 }],
        
        // Python
        ['.py', { language: 'python', confidence: 1.0 }],
        ['.pyx', { language: 'python', confidence: 0.9 }],
        ['.pyi', { language: 'python', confidence: 1.0 }],
        ['.pyw', { language: 'python', confidence: 1.0 }],
        
        // Java
        ['.java', { language: 'java', confidence: 1.0 }],
        
        // C/C++
        ['.c', { language: 'c', confidence: 1.0 }],
        ['.h', { language: 'c', confidence: 0.8 }], // Could be C++
        ['.cpp', { language: 'cpp', confidence: 1.0 }],
        ['.cxx', { language: 'cpp', confidence: 1.0 }],
        ['.cc', { language: 'cpp', confidence: 1.0 }],
        ['.hpp', { language: 'cpp', confidence: 1.0 }],
        ['.hxx', { language: 'cpp', confidence: 1.0 }],
        
        // Go
        ['.go', { language: 'go', confidence: 1.0 }],
        
        // Rust
        ['.rs', { language: 'rust', confidence: 1.0 }],
        
        // C#
        ['.cs', { language: 'csharp', confidence: 1.0 }],
        
        // PHP
        ['.php', { language: 'php', confidence: 1.0 }],
        
        // Ruby
        ['.rb', { language: 'ruby', confidence: 1.0 }],
        
        // Swift
        ['.swift', { language: 'swift', confidence: 1.0 }],
        
        // Kotlin
        ['.kt', { language: 'kotlin', confidence: 1.0 }],
        ['.kts', { language: 'kotlin', confidence: 1.0 }],
        
        // Shell
        ['.sh', { language: 'shell', confidence: 1.0 }],
        ['.bash', { language: 'shell', confidence: 1.0 }],
        ['.zsh', { language: 'shell', confidence: 1.0 }],
        
        // SQL
        ['.sql', { language: 'sql', confidence: 1.0 }],
        
        // YAML
        ['.yml', { language: 'yaml', confidence: 1.0 }],
        ['.yaml', { language: 'yaml', confidence: 1.0 }],
        
        // JSON
        ['.json', { language: 'json', confidence: 1.0 }],
        
        // Markdown
        ['.md', { language: 'markdown', confidence: 1.0 }],
        ['.markdown', { language: 'markdown', confidence: 1.0 }],
        
        // XML/HTML
        ['.xml', { language: 'xml', confidence: 1.0 }],
        ['.html', { language: 'html', confidence: 1.0 }],
        ['.htm', { language: 'html', confidence: 1.0 }],
        
        // CSS
        ['.css', { language: 'css', confidence: 1.0 }],
        ['.scss', { language: 'scss', confidence: 1.0 }],
        ['.sass', { language: 'sass', confidence: 1.0 }],
        ['.less', { language: 'less', confidence: 1.0 }]
    ]);

    private readonly FILE_TYPE_PATTERNS = [
        // Test files
        { pattern: /\.(test|spec|tests)\.[jt]sx?$/, type: 'test' as const },
        { pattern: /test_.*\.py$/, type: 'test' as const },
        { pattern: /.*_test\.py$/, type: 'test' as const },
        { pattern: /.*_test\.go$/, type: 'test' as const },
        { pattern: /.*Test\.java$/, type: 'test' as const },
        { pattern: /.*Tests\.cs$/, type: 'test' as const },
        
        // Config files
        { pattern: /^(webpack|rollup|vite|babel|eslint|prettier)\.config\.[jt]s$/, type: 'config' as const },
        { pattern: /^(tsconfig|jsconfig)\.json$/, type: 'config' as const },
        { pattern: /^package\.json$/, type: 'config' as const },
        { pattern: /^Cargo\.toml$/, type: 'config' as const },
        { pattern: /^pom\.xml$/, type: 'config' as const },
        { pattern: /^requirements\.txt$/, type: 'config' as const },
        { pattern: /^Pipfile$/, type: 'config' as const },
        { pattern: /^poetry\.lock$/, type: 'config' as const },
        { pattern: /^go\.mod$/, type: 'config' as const },
        { pattern: /\.config\.[jt]s$/, type: 'config' as const },
        
        // Documentation
        { pattern: /\.(md|markdown|rst|txt)$/i, type: 'documentation' as const },
        { pattern: /^README/i, type: 'documentation' as const },
        { pattern: /^CHANGELOG/i, type: 'documentation' as const },
        { pattern: /^LICENSE/i, type: 'documentation' as const },
        
        // Data files
        { pattern: /\.(json|yaml|yml|xml|csv|toml)$/i, type: 'data' as const }
    ];

    private readonly CONTENT_HINTS = [
        // JavaScript/TypeScript hints
        { pattern: /import\s+.*\s+from\s+['"]/, language: 'typescript', boost: 0.2 },
        { pattern: /export\s+(default\s+)?(class|function|const|interface)/, language: 'typescript', boost: 0.3 },
        { pattern: /interface\s+\w+/, language: 'typescript', boost: 0.4 },
        { pattern: /type\s+\w+\s*=/, language: 'typescript', boost: 0.3 },
        { pattern: /<\w+.*>.*<\/\w+>/, language: 'typescript', boost: 0.2 }, // JSX
        
        // Python hints
        { pattern: /^def\s+\w+\s*\(/, language: 'python', boost: 0.3 },
        { pattern: /^class\s+\w+\s*\(?\s*\w*\s*\)?:/, language: 'python', boost: 0.4 },
        { pattern: /import\s+\w+/, language: 'python', boost: 0.2 },
        { pattern: /from\s+\w+\s+import/, language: 'python', boost: 0.3 },
        
        // Java hints
        { pattern: /public\s+(class|interface|enum)\s+\w+/, language: 'java', boost: 0.4 },
        { pattern: /package\s+[\w.]+;/, language: 'java', boost: 0.3 },
        { pattern: /@\w+/, language: 'java', boost: 0.2 },
        
        // C/C++ hints
        { pattern: /#include\s*<.*>/, language: 'cpp', boost: 0.3 },
        { pattern: /namespace\s+\w+/, language: 'cpp', boost: 0.4 },
        { pattern: /class\s+\w+\s*{/, language: 'cpp', boost: 0.3 },
        
        // Go hints
        { pattern: /package\s+\w+/, language: 'go', boost: 0.3 },
        { pattern: /func\s+\w+\s*\(/, language: 'go', boost: 0.3 },
        { pattern: /import\s*\([\s\S]*?\)/, language: 'go', boost: 0.2 },
        
        // Rust hints
        { pattern: /fn\s+\w+\s*\(/, language: 'rust', boost: 0.3 },
        { pattern: /use\s+\w+(::\w+)*;/, language: 'rust', boost: 0.3 },
        { pattern: /struct\s+\w+\s*{/, language: 'rust', boost: 0.3 }
    ];

    /**
     * Detect language from file path and content
     */
    detectLanguage(filePath: string, content?: string): LanguageInfo {
        const fileName = path.basename(filePath);
        const extension = path.extname(filePath).toLowerCase();
        
        // Primary detection based on extension
        const extensionMatch = this.EXTENSION_MAP.get(extension);
        let language = extensionMatch?.language || 'text';
        let confidence = extensionMatch?.confidence || 0.1;
        
        // Enhance with content analysis if available
        if (content && content.length > 0) {
            const contentAnalysis = this.analyzeContent(content);
            
            if (contentAnalysis.language && contentAnalysis.confidence > confidence) {
                language = contentAnalysis.language;
                confidence = Math.min(contentAnalysis.confidence, 0.9); // Cap at 0.9 for content-based
            } else if (contentAnalysis.language === language) {
                // Boost confidence if content matches extension
                confidence = Math.min(confidence + contentAnalysis.confidence * 0.3, 1.0);
            }
        }
        
        // Determine file type
        const fileType = this.determineFileType(fileName, filePath);
        
        return {
            language,
            confidence,
            fileType
        };
    }

    /**
     * Analyze content for language hints
     */
    private analyzeContent(content: string): { language: string | null; confidence: number } {
        const languageScores = new Map<string, number>();
        const lines = content.split('\n').slice(0, 50); // Analyze first 50 lines
        const searchContent = lines.join('\n');
        
        // Apply content hints
        for (const hint of this.CONTENT_HINTS) {
            if (hint.pattern.test(searchContent)) {
                const currentScore = languageScores.get(hint.language) || 0;
                languageScores.set(hint.language, currentScore + hint.boost);
            }
        }
        
        if (languageScores.size === 0) {
            return { language: null, confidence: 0 };
        }
        
        // Find language with highest score
        let bestLanguage = '';
        let bestScore = 0;
        
        for (const [language, score] of languageScores.entries()) {
            if (score > bestScore) {
                bestLanguage = language;
                bestScore = score;
            }
        }
        
        return {
            language: bestLanguage,
            confidence: Math.min(bestScore, 0.8) // Cap content-based confidence
        };
    }

    /**
     * Determine file type (source, test, config, etc.)
     */
    private determineFileType(fileName: string, filePath: string): LanguageInfo['fileType'] {
        const normalizedName = fileName.toLowerCase();
        const normalizedPath = filePath.toLowerCase();
        
        // Check against patterns
        for (const pattern of this.FILE_TYPE_PATTERNS) {
            if (pattern.pattern.test(normalizedName) || pattern.pattern.test(normalizedPath)) {
                return pattern.type;
            }
        }
        
        // Check directory context
        if (normalizedPath.includes('/test/') || 
            normalizedPath.includes('/__tests__/') || 
            normalizedPath.includes('/tests/') ||
            normalizedPath.includes('/spec/')) {
            return 'test';
        }
        
        if (normalizedPath.includes('/config/') || 
            normalizedPath.includes('/configs/') ||
            normalizedPath.includes('/.config/')) {
            return 'config';
        }
        
        if (normalizedPath.includes('/docs/') || 
            normalizedPath.includes('/doc/') ||
            normalizedPath.includes('/documentation/')) {
            return 'documentation';
        }
        
        return 'source'; // Default to source
    }

    /**
     * Get all supported languages
     */
    getSupportedLanguages(): string[] {
        const languages = new Set<string>();
        
        for (const info of this.EXTENSION_MAP.values()) {
            languages.add(info.language);
        }
        
        return Array.from(languages).sort();
    }

    /**
     * Check if a language is supported for advanced processing
     */
    isLanguageSupported(language: string): boolean {
        // Languages with good AST parsing support
        const supportedLanguages = new Set([
            'typescript', 'javascript', 'python', 'java', 
            'cpp', 'c', 'go', 'rust', 'csharp'
        ]);
        
        return supportedLanguages.has(language.toLowerCase());
    }

    /**
     * Get file extension for a language
     */
    getPrimaryExtension(language: string): string | null {
        const extensionMap = new Map([
            ['typescript', '.ts'],
            ['javascript', '.js'],
            ['python', '.py'],
            ['java', '.java'],
            ['cpp', '.cpp'],
            ['c', '.c'],
            ['go', '.go'],
            ['rust', '.rs'],
            ['csharp', '.cs'],
            ['php', '.php'],
            ['ruby', '.rb'],
            ['swift', '.swift'],
            ['kotlin', '.kt']
        ]);
        
        return extensionMap.get(language.toLowerCase()) || null;
    }
}
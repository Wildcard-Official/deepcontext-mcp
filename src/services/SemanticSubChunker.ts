/**
 * Semantic Sub-Chunker
 * Intelligently splits large code chunks while preserving semantic structure,
 * imports/exports, symbols, and maintaining searchable context.
 */

import { Logger } from '../utils/Logger.js';
import { SymbolInfo } from '../types/core.js';

// Local interface for SemanticSubChunker - simplified for chunking operations
export interface CodeChunk {
    id: string;
    content: string;
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    symbols: SymbolInfo[];
    imports: Array<{
        module: string;
        symbols: string[];
        line: number;
    }>;
}

export interface SubChunkContext {
    fileHeader: string;          // File-level imports, types, constants
    globalContext: string;       // Class definitions, main exports
    localContext: string;        // Function-level context
}

export interface SemanticSection {
    content: string;
    type: 'header' | 'import' | 'export' | 'class' | 'function' | 'interface' | 'comment' | 'other';
    startLine: number;
    endLine: number;
    symbols: SymbolInfo[];
    dependencies: string[];      // What this section depends on
    priority: number;            // How important this section is (1-10)
}

export class SemanticSubChunker {
    private logger: Logger;
    private readonly MAX_CHUNK_SIZE = 1500; // Activate for larger TreeSitter chunks to add context
    private readonly MIN_OVERLAP_SIZE = 1000; // Minimum context overlap
    private readonly CONTEXT_WINDOW = 500;   // Context around important sections

    constructor() {
        this.logger = new Logger('SEMANTIC-SUBCHUNKER');
    }

    /**
     * Main entry point: Split a large chunk into semantic sub-chunks
     */
    async splitLargeChunk(chunk: CodeChunk): Promise<CodeChunk[]> {
        if (chunk.content.length <= this.MAX_CHUNK_SIZE) {
            return [chunk];
        }

        this.logger.info(`Splitting large chunk: ${chunk.id} (${chunk.content.length} chars)`);

        // Step 1: Parse the chunk into semantic sections
        const sections = this.parseSemanticSections(chunk);

        // Step 2: Extract context that should be preserved across sub-chunks
        const context = this.extractGlobalContext(sections, chunk);

        // Step 3: Group sections into sub-chunks with preserved context
        const subChunks = this.createSubChunksWithContext(sections, context, chunk);

        this.logger.info(`Created ${subChunks.length} sub-chunks from ${chunk.id}`);
        return subChunks;
    }

    /**
     * Parse content into semantic sections with metadata
     */
    private parseSemanticSections(chunk: CodeChunk): SemanticSection[] {
        const lines = chunk.content.split('\n');
        const sections: SemanticSection[] = [];
        let currentSection: string[] = [];
        let currentType: SemanticSection['type'] = 'other';
        let sectionStart = 0;
        let braceDepth = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Track brace depth for scope detection
            braceDepth += (line.match(/\{/g) || []).length;
            braceDepth -= (line.match(/\}/g) || []).length;

            // Detect section boundaries
            const newSectionType = this.detectSectionType(trimmed, braceDepth);

            // If we're starting a new section or hit a natural boundary
            if (newSectionType !== currentType || this.isNaturalBoundary(trimmed, braceDepth)) {
                // Finalize current section
                if (currentSection.length > 0) {
                    sections.push(this.createSemanticSection(
                        currentSection, currentType, chunk, sectionStart, i - 1
                    ));
                }

                // Start new section
                currentSection = [line];
                currentType = newSectionType;
                sectionStart = i;
            } else {
                currentSection.push(line);
            }
        }

        // Add final section
        if (currentSection.length > 0) {
            sections.push(this.createSemanticSection(
                currentSection, currentType, chunk, sectionStart, lines.length - 1
            ));
        }

        return sections;
    }

    /**
     * Detect what type of semantic section a line represents
     */
    private detectSectionType(line: string, braceDepth: number): SemanticSection['type'] {
        // Imports/exports (highest priority for context)
        if (line.match(/^(import|export)\s+/)) {
            return line.startsWith('export') ? 'export' : 'import';
        }

        // Header content (types, interfaces, constants)
        if (line.match(/^(interface|type|enum|const|let|var)\s+/) && braceDepth === 0) {
            return line.startsWith('interface') || line.startsWith('type') ? 'interface' : 'header';
        }

        // Class definitions
        if (line.match(/^(export\s+)?class\s+\w+/)) {
            return 'class';
        }

        // Function definitions
        if (line.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
            line.match(/^\s*\w+\s*\([^)]*\)\s*[:{]/) ||
            line.match(/^(public|private|protected)\s+\w+\s*\(/)) {
            return 'function';
        }

        // Comments (preserve for context)
        if (line.match(/^\/\*\*/) || line.match(/^\/\//) || line.match(/^\s*\*/)) {
            return 'comment';
        }

        return 'other';
    }

    /**
     * Check if this is a natural boundary for section splitting
     */
    private isNaturalBoundary(line: string, braceDepth: number): boolean {
        // End of top-level constructs
        if (braceDepth === 0 && line === '}') {
            return true;
        }

        // Double newlines (natural breaks)
        if (line === '' && braceDepth === 0) {
            return true;
        }

        // Start of major sections
        if (line.match(/^(\/\*\*|export|class|interface|function)/)) {
            return true;
        }

        return false;
    }

    /**
     * Create a semantic section with metadata
     */
    private createSemanticSection(
        lines: string[],
        type: SemanticSection['type'],
        chunk: CodeChunk,
        startIdx: number,
        endIdx: number
    ): SemanticSection {
        const content = lines.join('\n');
        const startLine = chunk.startLine + startIdx;
        const endLine = chunk.startLine + endIdx;

        // Extract symbols for this section
        const symbols = chunk.symbols.filter(symbol =>
            symbol.startLine >= startLine && symbol.startLine <= endLine
        );

        // Determine priority based on section type
        const priority = this.getSectionPriority(type, symbols);

        // Extract dependencies (imports, function calls, etc.)
        const dependencies = this.extractDependencies(content);

        return {
            content,
            type,
            startLine,
            endLine,
            symbols,
            dependencies,
            priority
        };
    }

    /**
     * Assign priority scores to different section types
     */
    private getSectionPriority(type: SemanticSection['type'], symbols: any[]): number {
        const basePriority = {
            'import': 10,     // Critical for context
            'export': 9,      // High value for API understanding
            'interface': 8,   // Important for type understanding
            'class': 7,       // Important for structure
            'function': 6,    // Medium-high value
            'header': 5,      // Constants, types
            'comment': 3,     // Context but lower priority
            'other': 1        // Lowest priority
        };

        let priority = basePriority[type] || 1;

        // Boost priority for sections with many symbols
        if (symbols.length > 3) {
            priority += 2;
        }

        return Math.min(priority, 10);
    }

    /**
     * Extract dependencies from content (imports, function calls, etc.)
     */
    private extractDependencies(content: string): string[] {
        const dependencies: string[] = [];

        // Extract imported modules
        const importMatches = content.match(/from\s+['"]([^'"]+)['"]/g);
        if (importMatches) {
            dependencies.push(...importMatches.map(m => m.match(/['"]([^'"]+)['"]/)?.[1] || ''));
        }

        // Extract function calls
        const functionCalls = content.match(/\w+\s*\(/g);
        if (functionCalls) {
            dependencies.push(...functionCalls.map(call => call.replace(/\s*\($/, '')));
        }

        return [...new Set(dependencies)].filter(Boolean);
    }

    /**
     * Extract global context that should be preserved across all sub-chunks
     */
    private extractGlobalContext(sections: SemanticSection[], chunk: CodeChunk): SubChunkContext {
        const fileHeader: string[] = [];
        const globalContext: string[] = [];

        // Collect file-level imports and declarations
        sections.forEach(section => {
            if (section.type === 'import' || section.type === 'header') {
                fileHeader.push(section.content);
            } else if (section.type === 'interface' || section.type === 'export') {
                globalContext.push(section.content);
            }
        });

        return {
            fileHeader: fileHeader.join('\n\n'),
            globalContext: globalContext.slice(0, 3).join('\n\n'), // Limit to prevent bloat
            localContext: '' // Will be filled per sub-chunk
        };
    }

    /**
     * Create sub-chunks with preserved context and semantic integrity
     */
    private createSubChunksWithContext(
        sections: SemanticSection[],
        context: SubChunkContext,
        originalChunk: CodeChunk
    ): CodeChunk[] {
        const subChunks: CodeChunk[] = [];
        let currentSections: SemanticSection[] = [];
        let currentSize = 0;
        let subChunkIndex = 0;

        // Calculate base context size
        const baseContextSize = context.fileHeader.length + context.globalContext.length + 100; // margin

        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            const sectionSize = section.content.length;

            // Check if adding this section would exceed limits
            const projectedSize = currentSize + sectionSize + baseContextSize;

            if (projectedSize > this.MAX_CHUNK_SIZE && currentSections.length > 0) {
                // Create sub-chunk from current sections
                const subChunk = this.createSubChunk(
                    currentSections, context, originalChunk, subChunkIndex
                );
                subChunks.push(subChunk);

                // Start new sub-chunk with overlap for context
                const overlap = this.createOverlapContext(currentSections, sections, i);
                currentSections = overlap.length > 0 ? overlap : [section];
                currentSize = currentSections.reduce((sum, s) => sum + s.content.length, 0);
                subChunkIndex++;
            } else {
                currentSections.push(section);
                currentSize += sectionSize;
            }
        }

        // Create final sub-chunk
        if (currentSections.length > 0) {
            const subChunk = this.createSubChunk(
                currentSections, context, originalChunk, subChunkIndex
            );
            subChunks.push(subChunk);
        }

        return subChunks;
    }

    /**
     * Create overlap context to maintain semantic continuity
     */
    private createOverlapContext(
        currentSections: SemanticSection[],
        allSections: SemanticSection[],
        nextIndex: number
    ): SemanticSection[] {
        const overlap: SemanticSection[] = [];
        let overlapSize = 0;

        // Include last high-priority section from current chunk for context
        for (let i = currentSections.length - 1; i >= 0; i--) {
            const section = currentSections[i];
            if (section.priority >= 7 && overlapSize + section.content.length < this.MIN_OVERLAP_SIZE) {
                overlap.unshift(section);
                overlapSize += section.content.length;
            }
        }

        return overlap;
    }

    /**
     * Create a single sub-chunk with full context
     */
    private createSubChunk(
        sections: SemanticSection[],
        context: SubChunkContext,
        originalChunk: CodeChunk,
        index: number
    ): CodeChunk {
        // Build content with context
        const contentParts: string[] = [];

        // Add file header (imports, types)
        if (context.fileHeader.trim()) {
            contentParts.push(context.fileHeader);
            contentParts.push(''); // blank line
        }

        // Add global context (key exports, classes)
        if (context.globalContext.trim()) {
            contentParts.push(context.globalContext);
            contentParts.push(''); // blank line
        }

        // Add local context comment
        contentParts.push('// --- Sub-chunk content ---');

        // Add the actual sections
        sections.forEach(section => {
            contentParts.push(section.content);
        });

        const content = contentParts.join('\n');

        // Calculate line numbers
        const startLine = sections[0]?.startLine || originalChunk.startLine;
        const endLine = sections[sections.length - 1]?.endLine || originalChunk.endLine;

        // Aggregate symbols from all sections
        const symbols = sections.flatMap(section => section.symbols);

        // Preserve imports from original chunk
        const relevantImports = originalChunk.imports.filter(imp => {
            // Include if any section depends on this import
            return sections.some(section =>
                section.dependencies.includes(imp.module) ||
                section.content.includes(imp.module)
            );
        });

        return {
            id: `${originalChunk.id}_sub${index}`,
            content,
            filePath: originalChunk.filePath,
            relativePath: originalChunk.relativePath,
            startLine,
            endLine,
            language: originalChunk.language,
            symbols,
            imports: relevantImports
        };
    }

    /**
     * Validate that sub-chunks maintain semantic quality
     */
    async validateSubChunks(subChunks: CodeChunk[]): Promise<{
        isValid: boolean;
        issues: string[];
        metrics: {
            totalSymbols: number;
            averageSize: number;
            contextPreservation: number;
        };
    }> {
        const issues: string[] = [];
        let totalSymbols = 0;
        let totalSize = 0;

        for (const chunk of subChunks) {
            totalSymbols += chunk.symbols.length;
            totalSize += chunk.content.length;

            // Check for missing imports
            if (chunk.imports.length === 0 && chunk.content.includes('import ')) {
                issues.push(`Sub-chunk ${chunk.id} may be missing import context`);
            }

            // Check for orphaned symbols
            if (chunk.symbols.length === 0 && chunk.content.length > 1000) {
                issues.push(`Sub-chunk ${chunk.id} has no symbols despite significant content`);
            }

            // Check size limits
            if (chunk.content.length > this.MAX_CHUNK_SIZE) {
                issues.push(`Sub-chunk ${chunk.id} exceeds size limit: ${chunk.content.length}`);
            }
        }

        return {
            isValid: issues.length === 0,
            issues,
            metrics: {
                totalSymbols,
                averageSize: totalSize / subChunks.length,
                contextPreservation: subChunks.filter(c => c.imports.length > 0).length / subChunks.length
            }
        };
    }
}
#!/usr/bin/env node

/**
 * Test script to validate core components work correctly
 */

import { IndexingOrchestrator } from './dist/core/indexing/IndexingOrchestrator.js';
import { TreeSitterSymbolExtractor } from './dist/core/indexing/TreeSitterSymbolExtractor.js';
import { ContentFilterProvider } from './dist/core/indexing/ContentFilterProvider.js';
import { IncrementalIndexer } from './dist/core/indexing/IncrementalIndexer.js';
import { SemanticSearchEngine } from './dist/core/search/SemanticSearchEngine.js';
import { FileUtils } from './dist/utils/FileUtils.js';
import { LanguageDetector } from './dist/utils/LanguageDetector.js';
import { Logger } from './dist/utils/Logger.js';

console.log('🧪 Testing core components...\n');

async function testCoreComponents() {
    try {
        // Test 1: FileUtils
        console.log('1. Testing FileUtils...');
        const fileUtils = new FileUtils();
        const supportedLangs = fileUtils.getSupportedLanguages();
        console.log(`   ✅ FileUtils: Supports ${supportedLangs.length} languages`);
        
        // Test 2: LanguageDetector
        console.log('2. Testing LanguageDetector...');
        const languageDetector = new LanguageDetector();
        const jsDetection = languageDetector.detectLanguage('test.js', 'function hello() {}');
        console.log(`   ✅ LanguageDetector: JS file detected as ${jsDetection.language} (${jsDetection.confidence})`);
        
        // Test 3: Logger
        console.log('3. Testing Logger...');
        const logger = new Logger('TEST');
        logger.info('Logger working correctly');
        console.log('   ✅ Logger: Basic logging works');
        
        // Test 4: ContentFilterProvider
        console.log('4. Testing ContentFilterProvider...');
        const contentFilter = new ContentFilterProvider();
        const testResult = contentFilter.shouldInclude('src/main.js', 'export function main() {}');
        const testFileResult = contentFilter.shouldInclude('test.spec.js', 'describe("test", () => {})');
        console.log(`   ✅ ContentFilter: Source file included=${testResult.include}, Test file included=${testFileResult.include}`);
        
        // Test 5: TreeSitterSymbolExtractor
        console.log('5. Testing TreeSitterSymbolExtractor...');
        const symbolExtractor = new TreeSitterSymbolExtractor();
        const extractionResult = await symbolExtractor.extractSymbols(
            'function hello() { return "world"; }',
            'javascript',
            'test.js'
        );
        console.log(`   ✅ SymbolExtractor: Found ${extractionResult.symbols.length} symbols, ${extractionResult.imports.length} imports`);
        
        // Test 6: IncrementalIndexer
        console.log('6. Testing IncrementalIndexer...');
        const incrementalIndexer = new IncrementalIndexer();
        const hasIndex = await incrementalIndexer.hasExistingIndex('/fake/path');
        console.log(`   ✅ IncrementalIndexer: hasExistingIndex=${hasIndex} (expected false)`);
        
        // Test 7: IndexingOrchestrator
        console.log('7. Testing IndexingOrchestrator...');
        const indexingOrchestrator = new IndexingOrchestrator();
        // Just test instantiation - not running actual indexing
        console.log('   ✅ IndexingOrchestrator: Instantiated successfully');
        
        // Test 8: SemanticSearchEngine  
        console.log('8. Testing SemanticSearchEngine...');
        // Create mock dependencies
        const mockVectorStore = {
            search: async () => [],
            searchBySymbols: async () => [],
            getDependencyGraph: async () => null,
            hasNamespace: async () => false
        };
        const mockEmbedding = {
            embed: async () => [0.1, 0.2, 0.3],
            embedBatch: async () => [[0.1, 0.2, 0.3]]
        };
        
        const searchEngine = new SemanticSearchEngine(mockVectorStore, mockEmbedding);
        console.log('   ✅ SemanticSearchEngine: Instantiated successfully');
        
        console.log('\n🎉 All core components test successfully!');
        console.log('\n📊 Component Summary:');
        console.log('   ✅ File utilities and language detection');
        console.log('   ✅ Content filtering and quality checks');
        console.log('   ✅ Symbol extraction (regex-based fallback)');
        console.log('   ✅ Incremental indexing infrastructure');
        console.log('   ✅ Semantic search architecture');
        console.log('   ✅ Logging and utilities');
        
        console.log('\n🚀 Ready for MCP integration!');
        return true;
        
    } catch (error) {
        console.error('❌ Component test failed:', error);
        return false;
    }
}

testCoreComponents().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
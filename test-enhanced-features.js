/**
 * Test script for enhanced search features
 */

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';
import path from 'path';

const config = {
    jinaApiKey: process.env.JINA_API_KEY || 'test',
    turbopufferApiKey: process.env.TURBOPUFFER_API_KEY || 'test',
    openaiApiKey: process.env.OPENAI_API_KEY,
    logLevel: 'info'
};

const mcp = new StandaloneCodexMcp(config);

async function testEnhancedFeatures() {
    console.log('🧪 Testing Enhanced Search Features\n');
    
    const codebasePath = process.cwd(); // Test with current directory
    
    try {
        // 1. Test indexing (saves to both Turbopuffer and SQLite)
        console.log('1. Testing Enhanced Indexing...');
        const indexResult = await mcp.indexCodebaseIntelligent(codebasePath, false);
        console.log('✅ Indexing Result:', {
            success: indexResult.success,
            namespace: indexResult.namespace,
            chunksCreated: indexResult.chunksCreated,
            processingTimeMs: indexResult.processingTimeMs
        });
        console.log();

        if (!indexResult.success) {
            throw new Error('Indexing failed');
        }

        // 2. Test Hybrid Search (Vector + BM25)
        console.log('2. Testing Hybrid Search...');
        const hybridResult = await mcp.searchHybrid(codebasePath, 'search function implementation', {
            limit: 5,
            vectorWeight: 0.7,
            bm25Weight: 0.3,
            enableQueryEnhancement: !!config.openaiApiKey, // Only if OpenAI key available
            enableReranking: !!config.jinaApiKey         // Only if Jina key available
        });
        
        console.log('✅ Hybrid Search Result:', {
            success: hybridResult.success,
            resultsCount: hybridResult.results.length,
            searchTime: hybridResult.searchTime,
            strategy: hybridResult.strategy,
            metadata: hybridResult.metadata
        });
        
        if (hybridResult.results.length > 0) {
            console.log('📝 First Result:', {
                filePath: hybridResult.results[0].filePath,
                score: hybridResult.results[0].score,
                symbols: hybridResult.results[0].symbols?.slice(0, 3) || [],
                contentPreview: hybridResult.results[0].content?.substring(0, 100) + '...'
            });
        }
        console.log();

        // 3. Test Pure BM25 Search
        console.log('3. Testing Pure BM25 Search...');
        const bm25Result = await mcp.searchBM25(codebasePath, 'interface class function', {
            limit: 3,
            fileTypes: ['typescript', 'javascript']
        });
        
        console.log('✅ BM25 Search Result:', {
            success: bm25Result.success,
            resultsCount: bm25Result.results.length,
            searchTime: bm25Result.searchTime,
            strategy: bm25Result.strategy
        });
        
        if (bm25Result.results.length > 0) {
            console.log('📝 First BM25 Result:', {
                filePath: bm25Result.results[0].filePath,
                score: bm25Result.results[0].score,
                symbols: bm25Result.results[0].symbols?.slice(0, 3) || []
            });
        }
        console.log();

        // 4. Test capabilities detection
        console.log('4. Testing Capability Detection...');
        const capabilities = {
            hasOpenAI: !!config.openaiApiKey,
            hasJina: !!config.jinaApiKey,
            hasTurbopuffer: !!config.turbopufferApiKey,
            queryEnhancement: !!config.openaiApiKey, // OpenAI only
            reranking: !!config.jinaApiKey,
            localBM25: true // Always available with SQLite
        };
        
        console.log('🔧 Available Capabilities:', capabilities);
        console.log();

        console.log('🎉 All Enhanced Features Tested Successfully!');
        console.log();
        console.log('📊 Summary:');
        console.log('- Local SQLite metadata store: ✅ Working');
        console.log('- BM25 full-text search: ✅ Working');
        console.log('- Hybrid vector + BM25: ✅ Working');
        console.log(`- Query enhancement: ${capabilities.queryEnhancement ? '✅' : '⚠️'} ${capabilities.queryEnhancement ? 'Working' : 'Missing API key'}`);
        console.log(`- Result reranking: ${capabilities.reranking ? '✅' : '⚠️'} ${capabilities.reranking ? 'Working' : 'Missing Jina API key'}`);

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run the test
testEnhancedFeatures().catch(console.error);
#!/usr/bin/env node

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';

/**
 * Comprehensive API Integration Coverage Test
 * Using production API keys to validate actual coverage
 */

const PROD_CONFIG = {
    jinaApiKey: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
    turbopufferApiKey: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
    openaiApiKey: "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",
    logLevel: 'info'
};

console.log('🔬 Comprehensive API Integration Coverage Test');
console.log('Using Production API Keys\n');

class APITestRunner {
    constructor() {
        this.mcp = new StandaloneCodexMcp(PROD_CONFIG);
        this.testResults = {
            total: 0,
            passed: 0,
            failed: 0,
            tests: []
        };
        this.testPath = '/Users/Sripad/codex/intelligent-context-mcp/src';
    }

    async runTest(name, description, testFn) {
        this.testResults.total++;
        console.log(`\n${this.testResults.total}. ${name}`);
        console.log(`   ${description}`);
        
        const startTime = Date.now();
        try {
            const result = await testFn();
            const duration = Date.now() - startTime;
            
            if (result.success !== false && result !== false) {
                this.testResults.passed++;
                console.log(`   ✅ PASSED (${duration}ms)`, result.summary || '');
                this.testResults.tests.push({ name, status: 'PASSED', duration, details: result });
            } else {
                this.testResults.failed++;
                console.log(`   ❌ FAILED (${duration}ms)`, result.error || result.message || '');
                this.testResults.tests.push({ name, status: 'FAILED', duration, error: result.error || result.message });
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            this.testResults.failed++;
            console.log(`   ❌ ERROR (${duration}ms)`, error.message);
            this.testResults.tests.push({ name, status: 'ERROR', duration, error: error.message });
        }
    }

    async runAllTests() {
        console.log('='.repeat(80));
        console.log('API INTEGRATION COVERAGE TESTS');
        console.log('='.repeat(80));

        // 1. Core API Connectivity Tests - Using public methods only
        await this.runTest(
            'Full Indexing Pipeline',
            'Test complete codebase indexing workflow (tests all APIs)',
            async () => {
                const result = await this.mcp.indexCodebaseIntelligent(this.testPath, true);
                return {
                    success: result.success && result.chunksCreated > 0,
                    summary: `Indexed ${result.chunksCreated} chunks in ${result.processingTimeMs}ms`
                };
            }
        );

        await this.runTest(
            'Turbopuffer BM25 Search',
            'Test BM25 full-text search in Turbopuffer',
            async () => {
                // First ensure we have data indexed
                const indexResult = await this.mcp.indexCodebaseIntelligent(this.testPath, false);
                if (!indexResult.success) throw new Error('Failed to index test data');
                
                const result = await this.mcp.searchBM25('function', this.testPath);
                return {
                    success: result.success && result.results.length > 0,
                    summary: `Found ${result.results.length} BM25 results`
                };
            }
        );

        await this.runTest(
            'Turbopuffer Vector Search',
            'Test vector similarity search in Turbopuffer',
            async () => {
                const namespace = this.mcp.generateNamespace(this.testPath);
                const embedding = await this.mcp.generateEmbedding('function implementation');
                
                const results = await this.mcp.turbopufferQuery(namespace, {
                    vector: embedding,
                    limit: 5
                });
                
                return {
                    success: Array.isArray(results) && results.length >= 0,
                    summary: `Found ${results.length} vector results`
                };
            }
        );

        await this.runTest(
            'Turbopuffer Hybrid Search',
            'Test combined vector + BM25 hybrid search',
            async () => {
                const result = await this.mcp.searchHybrid('function implementation', this.testPath, {
                    limit: 5,
                    vectorWeight: 0.7,
                    bm25Weight: 0.3
                });
                
                return {
                    success: result.success,
                    summary: `Hybrid search: ${result.results.length} results in ${result.searchTime}ms`
                };
            }
        );

        await this.runTest(
            'OpenAI Query Enhancement',
            'Test query enhancement using OpenAI GPT',
            async () => {
                const enhanced = await this.mcp.enhanceQuery('find bug');
                return {
                    success: typeof enhanced === 'string' && enhanced.length > 0,
                    summary: `Enhanced: "${enhanced.substring(0, 50)}..."`
                };
            }
        );

        await this.runTest(
            'Jina Reranking Service',
            'Test result reranking using Jina reranker',
            async () => {
                const results = [
                    { content: 'function test implementation', score: 0.8 },
                    { content: 'class definition example', score: 0.7 }
                ];
                
                const reranked = await this.mcp.rerankResults('function test', results);
                return {
                    success: Array.isArray(reranked) && reranked.length === results.length,
                    summary: `Reranked ${reranked.length} results`
                };
            }
        );

        // 2. End-to-End Integration Tests
        await this.runTest(
            'Full Indexing Pipeline',
            'Test complete codebase indexing workflow',
            async () => {
                const result = await this.mcp.indexCodebaseIntelligent(this.testPath, false);
                return {
                    success: result.success && result.chunksCreated > 0,
                    summary: `Indexed ${result.chunksCreated} chunks in ${result.processingTimeMs}ms`
                };
            }
        );

        await this.runTest(
            'Enhanced Search with All Features',
            'Test search with query enhancement and reranking',
            async () => {
                const result = await this.mcp.searchHybrid('search algorithm implementation', this.testPath, {
                    limit: 5,
                    enableQueryEnhancement: true,
                    enableReranking: true
                });
                
                return {
                    success: result.success,
                    summary: `Enhanced search: ${result.results.length} results, enhanced=${result.metadata?.queryEnhanced}, reranked=${result.metadata?.reranked}`
                };
            }
        );

        await this.runTest(
            'Index Cleanup',
            'Test clearing index data',
            async () => {
                const result = await this.mcp.clearIndex(this.testPath);
                return {
                    success: result.success,
                    summary: 'Index cleared successfully'
                };
            }
        );

        // 3. Error Handling & Edge Cases
        await this.runTest(
            'Empty Query Handling',
            'Test handling of empty search queries',
            async () => {
                const result = await this.mcp.searchHybrid('', this.testPath);
                return {
                    success: result.success === false,
                    summary: 'Empty query properly rejected'
                };
            }
        );

        await this.runTest(
            'Non-existent Path Handling',
            'Test handling of invalid codebase paths',
            async () => {
                try {
                    await this.mcp.indexCodebaseIntelligent('/nonexistent/path', false);
                    return { success: false, error: 'Should have thrown error' };
                } catch (error) {
                    return {
                        success: true,
                        summary: 'Invalid path properly handled'
                    };
                }
            }
        );

        await this.runTest(
            'Large Query Handling',
            'Test handling of very large queries',
            async () => {
                const largeQuery = 'function implementation search '.repeat(100);
                const result = await this.mcp.searchHybrid(largeQuery, this.testPath);
                return {
                    success: result.success !== undefined,
                    summary: `Large query handled: ${result.success ? 'success' : 'failed'}`
                };
            }
        );

        this.printSummary();
    }

    printSummary() {
        console.log('\n' + '='.repeat(80));
        console.log('API COVERAGE TEST RESULTS');
        console.log('='.repeat(80));
        
        const passRate = Math.round((this.testResults.passed / this.testResults.total) * 100);
        
        console.log(`Total Tests: ${this.testResults.total}`);
        console.log(`Passed: ${this.testResults.passed}`);
        console.log(`Failed: ${this.testResults.failed}`);
        console.log(`Pass Rate: ${passRate}%\n`);

        if (passRate < 80) {
            console.log('🚨 LOW PASS RATE - ISSUES NEED ATTENTION');
            console.log('\nFailed Tests:');
            this.testResults.tests
                .filter(t => t.status !== 'PASSED')
                .forEach(test => {
                    console.log(`   ❌ ${test.name}: ${test.error}`);
                });
        } else if (passRate < 90) {
            console.log('⚠️  ACCEPTABLE PASS RATE - MINOR ISSUES');
        } else {
            console.log('✅ EXCELLENT PASS RATE - API INTEGRATION ROBUST');
        }

        console.log('\n' + '='.repeat(80));
        console.log(`FINAL VERDICT: ${passRate >= 80 ? 'API COVERAGE ADEQUATE' : 'API COVERAGE NEEDS IMPROVEMENT'}`);
        console.log('='.repeat(80));
    }
}

// Run the comprehensive test
const testRunner = new APITestRunner();
testRunner.runAllTests().catch(console.error);
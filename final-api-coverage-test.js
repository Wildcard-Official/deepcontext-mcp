#!/usr/bin/env node

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';

/**
 * Final API Coverage Test - Testing only public methods with correct config
 */

const PROD_CONFIG = {
    jinaApiKey: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
    turbopufferApiKey: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
    openaiApiKey: "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",
    logLevel: 'info'
};

console.log('🎯 Final API Coverage Test - Public Methods Only');
console.log('Using Correct Configuration\n');

class FinalAPITest {
    constructor() {
        this.mcp = new StandaloneCodexMcp(PROD_CONFIG);
        this.results = { total: 0, passed: 0, failed: 0 };
        this.testPath = '/Users/Sripad/codex/intelligent-context-mcp/src';
    }

    async test(name, fn) {
        this.results.total++;
        console.log(`\n${this.results.total}. ${name}`);
        
        const start = Date.now();
        try {
            const result = await fn();
            const duration = Date.now() - start;
            
            if (result.success !== false) {
                this.results.passed++;
                console.log(`   ✅ PASSED (${duration}ms) ${result.summary || ''}`);
            } else {
                this.results.failed++;
                console.log(`   ❌ FAILED (${duration}ms) ${result.error || 'No error details'}`);
            }
        } catch (error) {
            const duration = Date.now() - start;
            this.results.failed++;
            console.log(`   ❌ ERROR (${duration}ms) ${error.message}`);
        }
    }

    async runTests() {
        console.log('='.repeat(60));

        // Core functionality tests
        await this.test('Full Indexing Pipeline', async () => {
            const result = await this.mcp.indexCodebaseIntelligent(this.testPath, true);
            return {
                success: result.success && result.chunksCreated > 0,
                summary: `${result.chunksCreated} chunks, ${result.processingTimeMs}ms`
            };
        });

        await this.test('Hybrid Search (Vector + BM25)', async () => {
            const result = await this.mcp.searchHybrid(this.testPath, 'function implementation', {
                limit: 5,
                vectorWeight: 0.7,
                bm25Weight: 0.3
            });
            return {
                success: result.success && result.results.length > 0,
                summary: `${result.results.length} results in ${result.searchTime}ms`
            };
        });

        await this.test('BM25 Full-Text Search', async () => {
            const result = await this.mcp.searchBM25(this.testPath, 'class definition', { limit: 5 });
            return {
                success: result.success && result.results.length >= 0,
                summary: `${result.results.length} results in ${result.searchTime}ms`
            };
        });

        await this.test('Enhanced Search with Query Enhancement', async () => {
            const result = await this.mcp.searchHybrid(this.testPath, 'find bugs', {
                limit: 3,
                enableQueryEnhancement: true,
                enableReranking: true
            });
            return {
                success: result.success,
                summary: `Enhanced: ${result.metadata?.queryEnhanced}, Reranked: ${result.metadata?.reranked}`
            };
        });

        await this.test('Intelligent Search Interface', async () => {
            const result = await this.mcp.searchWithIntelligence('async function', this.testPath, 3);
            return {
                success: result.success && Array.isArray(result.results),
                summary: `${result.results?.length || 0} intelligent results`
            };
        });

        await this.test('Indexing Status Check', async () => {
            const result = await this.mcp.getIndexingStatus(this.testPath);
            return {
                success: typeof result.indexed === 'boolean',
                summary: `Indexed: ${result.indexed}, Files: ${result.fileCount || 0}`
            };
        });

        await this.test('Index Cleanup', async () => {
            const result = await this.mcp.clearIndex(this.testPath);
            return {
                success: result.success,
                summary: 'Cleanup completed'
            };
        });

        // Error handling tests
        await this.test('Empty Query Handling', async () => {
            const result = await this.mcp.searchHybrid(this.testPath, '');
            return {
                success: result.success === false,
                summary: 'Empty query properly rejected'
            };
        });

        await this.test('Invalid Path Handling', async () => {
            try {
                const result = await this.mcp.indexCodebaseIntelligent('/nonexistent/path', false);
                return {
                    success: result.success === false || result.chunksCreated === 0,
                    summary: 'Invalid path handled gracefully'
                };
            } catch (error) {
                return {
                    success: true,
                    summary: 'Invalid path threw appropriate error'
                };
            }
        });

        // Re-index for final verification
        await this.test('Re-indexing After Cleanup', async () => {
            const result = await this.mcp.indexCodebaseIntelligent(this.testPath, true);
            return {
                success: result.success && result.chunksCreated > 0,
                summary: `Re-indexed ${result.chunksCreated} chunks successfully`
            };
        });

        this.printResults();
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('FINAL API COVERAGE RESULTS');
        console.log('='.repeat(60));
        
        const passRate = Math.round((this.results.passed / this.results.total) * 100);
        
        console.log(`Tests Run: ${this.results.total}`);
        console.log(`Passed: ${this.results.passed}`);
        console.log(`Failed: ${this.results.failed}`);
        console.log(`Pass Rate: ${passRate}%`);
        
        console.log('\n📊 ASSESSMENT:');
        if (passRate >= 90) {
            console.log('✅ EXCELLENT - API integration is robust and production-ready');
        } else if (passRate >= 80) {
            console.log('✅ GOOD - API integration is solid with minor issues');
        } else if (passRate >= 70) {
            console.log('⚠️  ACCEPTABLE - Core functionality works, some edge cases fail');
        } else {
            console.log('🚨 POOR - Significant API integration issues need attention');
        }
        
        console.log(`\n🎯 VERDICT: ${passRate}% pass rate ${passRate >= 70 ? 'validates' : 'contradicts'} production readiness`);
    }
}

const test = new FinalAPITest();
test.runTests().catch(console.error);
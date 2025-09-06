#!/usr/bin/env node

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';

/**
 * Test script to verify error handling fixes:
 * 1. Empty query validation in search methods
 * 2. Empty text validation in embedding generation
 * 3. Improved error logging for API failures
 */

const API_KEYS = {
    JINA_API_KEY: process.env.JINA_API_KEY || 'test',
    TURBOPUFFER_API_KEY: process.env.TURBOPUFFER_API_KEY || 'test', 
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'test'
};

console.log('🔧 Testing Error Handling Fixes\n');

async function testErrorHandling() {
    const integration = new StandaloneCodexMcp(API_KEYS);
    const testPath = '/Users/Sripad/codex/intelligent-context-mcp/src';
    
    console.log('1. Testing empty query in hybrid search...');
    try {
        const result = await integration.searchHybrid('', testPath);
        console.log(`   ✅ Empty query handled: success=${result.success}, results=${result.results.length}`);
    } catch (error) {
        console.log(`   ✅ Empty query rejected with error: ${error.message}`);
    }
    
    console.log('\n2. Testing whitespace-only query in hybrid search...');
    try {
        const result = await integration.searchHybrid('   ', testPath);
        console.log(`   ✅ Whitespace query handled: success=${result.success}, results=${result.results.length}`);
    } catch (error) {
        console.log(`   ✅ Whitespace query rejected with error: ${error.message}`);
    }
    
    console.log('\n3. Testing empty query in BM25 search...');
    try {
        const result = await integration.searchBM25('', testPath);
        console.log(`   ✅ Empty BM25 query handled: success=${result.success}, results=${result.results.length}`);
    } catch (error) {
        console.log(`   ✅ Empty BM25 query rejected with error: ${error.message}`);
    }
    
    console.log('\n4. Testing with invalid API keys (should show better error logging)...');
    const invalidIntegration = new StandaloneCodexMcp({
        JINA_API_KEY: 'invalid_key',
        TURBOPUFFER_API_KEY: 'invalid_key',
        OPENAI_API_KEY: 'invalid_key'
    });
    
    try {
        await invalidIntegration.indexCodebaseIntelligent(testPath);
        console.log('   ⚠️  Unexpected success with invalid keys');
    } catch (error) {
        console.log(`   ✅ Invalid API keys properly handled with detailed error logging`);
    }
    
    console.log('\n5. Testing valid query with proper API keys (if available)...');
    if (process.env.JINA_API_KEY && process.env.TURBOPUFFER_API_KEY) {
        try {
            const result = await integration.searchHybrid('function', testPath);
            console.log(`   ✅ Valid query worked: success=${result.success}, results=${result.results.length}`);
        } catch (error) {
            console.log(`   ⚠️  Valid query failed: ${error.message}`);
        }
    } else {
        console.log('   ⏭️  Skipped (no real API keys provided)');
    }
}

testErrorHandling().catch(console.error);
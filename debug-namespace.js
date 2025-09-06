#!/usr/bin/env node

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';
import crypto from 'crypto';
import path from 'path';

const PROD_CONFIG = {
    jinaApiKey: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
    turbopufferApiKey: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
    openaiApiKey: "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",
    logLevel: 'info'
};

// Test namespace generation consistency
const testPath = '/Users/Sripad/codex/intelligent-context-mcp/src';

console.log('🔍 Debugging Namespace Generation');
console.log(`Test Path: ${testPath}`);

// Manual namespace generation (as per the code)
function generateNamespace(codebasePath) {
    const normalized = path.resolve(codebasePath);
    const hash = crypto.createHash('md5').update(normalized).digest('hex');
    return `mcp_${hash.substring(0, 8)}`;
}

const expectedNamespace = generateNamespace(testPath);
console.log(`Expected Namespace: ${expectedNamespace}`);

// Check method signatures
const mcp = new StandaloneCodexMcp(PROD_CONFIG);

console.log('\n📝 Testing actual method calls:');

async function testMethods() {
    try {
        // Test if the order is wrong in our test
        console.log('\n1. Testing searchHybrid method signature...');
        console.log('   Calling: searchHybrid(query, codebasePath) - WRONG ORDER');
        const result1 = await mcp.searchHybrid('function implementation', testPath, { limit: 1 });
        console.log(`   Result: success=${result1.success}`);
    } catch (error) {
        console.log(`   Error: ${error.message}`);
    }
    
    try {
        console.log('\n2. Testing searchHybrid with correct parameter order...');
        console.log('   Calling: searchHybrid(codebasePath, query) - CORRECT ORDER'); 
        const result2 = await mcp.searchHybrid(testPath, 'function implementation', { limit: 1 });
        console.log(`   Result: success=${result2.success}`);
    } catch (error) {
        console.log(`   Error: ${error.message}`);
    }
}

testMethods().catch(console.error);
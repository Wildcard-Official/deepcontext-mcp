#!/usr/bin/env node

import { StandaloneCodexMcp } from './dist/standalone-mcp-integration.js';

const PROD_CONFIG = {
    jinaApiKey: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
    turbopufferApiKey: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
    openaiApiKey: "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",
    logLevel: 'info'
};

const mcp = new StandaloneCodexMcp(PROD_CONFIG);
const testPath = '/Users/Sripad/codex/intelligent-context-mcp/src';

console.log('🔍 Testing getIndexingStatus method\n');

async function testIndexingStatus() {
    console.log('1. Testing status before indexing...');
    const statusBefore = await mcp.getIndexingStatus(testPath);
    console.log('Status before indexing:', JSON.stringify(statusBefore, null, 2));
    
    console.log('\n2. Indexing codebase...');
    const indexResult = await mcp.indexCodebaseIntelligent(testPath, true);
    console.log(`Indexing result: success=${indexResult.success}, chunks=${indexResult.chunksCreated}`);
    
    console.log('\n3. Testing status after indexing...');
    const statusAfter = await mcp.getIndexingStatus(testPath);
    console.log('Status after indexing:', JSON.stringify(statusAfter, null, 2));
    
    console.log('\n4. Testing status without specific path...');
    const statusGeneral = await mcp.getIndexingStatus();
    console.log('General status:', JSON.stringify(statusGeneral, null, 2));
    
    console.log('\n5. Analysis of what the test expects...');
    console.log('The test expects:');
    console.log('  - result.indexed (boolean)');
    console.log('  - result.fileCount (number)');
    
    console.log('What we actually get:');
    console.log('  - result.indexedCodebases (array)');
    console.log('  - result.currentCodebase (object or undefined)');
    console.log('  - result.incrementalStats (object or undefined)');
    
    console.log('\n6. Simple fix needed:');
    console.log('The method should return a simple format for basic status checks');
}

testIndexingStatus().catch(console.error);
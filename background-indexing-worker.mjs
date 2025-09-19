// Production background indexing worker process
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { StandaloneContextMcp } from './dist/standalone-mcp-integration.js';

// Get command line arguments
const codebasePath = process.argv[2];
const forceReindex = process.argv[3] === 'true';

if (!codebasePath) {
    console.error('[BACKGROUND] ❌ Error: No codebase path provided');
    process.exit(1);
}

console.log(`[BACKGROUND] Starting indexing for: ${codebasePath}`);

console.log(`[BACKGROUND] Using Wildcard API`);
console.log(`[BACKGROUND] Wildcard API Key: ${process.env.WILDCARD_API_KEY?.substring(0, 10)}...`);
console.log(`[BACKGROUND] Wildcard API URL: ${process.env.WILDCARD_API_URL}`);

if (!process.env.WILDCARD_API_KEY) {
    console.error('[BACKGROUND] ❌ Error: WILDCARD_API_KEY environment variable is required');
    process.exit(1);
}

try {
    const context = new StandaloneContextMcp({
        wildcardApiKey: process.env.WILDCARD_API_KEY
    });

    console.log('[BACKGROUND] Initialized successfully');
    
    // Initialize the namespace manager to ensure registry is loaded
    await context.initialize();
    console.log('[BACKGROUND] Namespace manager initialized');

    console.log('[BACKGROUND] About to start indexCodebase()...');
    console.log('[BACKGROUND] Codebase path:', codebasePath);
    console.log('[BACKGROUND] Force reindex:', forceReindex);

    const result = await context.indexCodebase(codebasePath, forceReindex);

    console.log('[BACKGROUND] Raw result:', JSON.stringify(result, null, 2));
    console.log(`[BACKGROUND] ✅ Indexing completed for ${codebasePath}: ${result.chunksCreated} chunks`);

    // Register the codebase in the namespace manager if indexing succeeded
    if (result.success && result.chunksCreated > 0) {
        try {
            await context.namespaceManagerService.registerCodebase(
                codebasePath,
                result.chunksCreated,
                new Date()
            );
            console.log('[BACKGROUND] ✅ Codebase registered in namespace manager');
        } catch (error) {
            console.error('[BACKGROUND] ⚠️  Failed to register codebase:', error.message);
        }
    }

    if (result.chunksCreated === 0 || !result.success) {
        console.log('[BACKGROUND] ⚠️  Zero chunks created or indexing failed - investigating...');
        console.log('[BACKGROUND] Success:', result.success);
        console.log('[BACKGROUND] Message:', result.message);
        console.log('[BACKGROUND] Files processed:', result.filesProcessed);
        console.log('[BACKGROUND] Processing time:', result.processingTimeMs + 'ms');
        console.log('[BACKGROUND] Namespace:', result.namespace);
        console.log('[BACKGROUND] Errors property:', result.errors);
        console.log('[BACKGROUND] Errors:', result.errors ? result.errors.length : 'none');
        
        // Print actual error details if available
        if (result.errors && result.errors.length > 0) {
            console.log('[BACKGROUND] Error details:');
            result.errors.forEach((error, index) => {
                console.log(`[BACKGROUND]   Error ${index + 1}: File: ${error.file}, Error: ${error.error}`);
            });
        }
        
        console.log('[BACKGROUND] All result keys:', Object.keys(result).join(', '));
    }
} catch (error) {
    console.error(`[BACKGROUND] ❌ Indexing failed for ${codebasePath}:`, error.message);
    console.error('[BACKGROUND] Stack trace:', error.stack);
    process.exit(1);
}
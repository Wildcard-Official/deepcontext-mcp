#!/usr/bin/env node

/**
 * Validate API keys individually to identify the root cause
 */

const API_KEYS = {
    JINA_API_KEY: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
    TURBOPUFFER_API_KEY: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
    OPENAI_API_KEY: "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"
};

console.log('🔍 Individual API Key Validation\n');

// Test Jina AI directly
async function testJinaAI() {
    console.log('1. Testing Jina AI Embedding API...');
    try {
        const response = await fetch('https://api.jina.ai/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEYS.JINA_API_KEY}`
            },
            body: JSON.stringify({
                model: 'jina-embeddings-v2-base-en',
                input: ['test text']
            })
        });

        const data = await response.text();
        console.log(`   Status: ${response.status}`);
        console.log(`   Response: ${data.substring(0, 200)}...`);
        
        if (response.status === 401) {
            console.log('   ❌ JINA API KEY IS INVALID/EXPIRED');
            return false;
        } else if (response.status === 200) {
            console.log('   ✅ JINA API KEY IS VALID');
            return true;
        }
    } catch (error) {
        console.log(`   ❌ Network error: ${error.message}`);
        return false;
    }
}

// Test Turbopuffer directly
async function testTurbopuffer() {
    console.log('\n2. Testing Turbopuffer API...');
    try {
        const response = await fetch('https://api.turbopuffer.com/v1/vectors', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEYS.TURBOPUFFER_API_KEY}`
            }
        });

        const data = await response.text();
        console.log(`   Status: ${response.status}`);
        console.log(`   Response: ${data.substring(0, 200)}...`);
        
        if (response.status === 401) {
            console.log('   ❌ TURBOPUFFER API KEY IS INVALID');
            return false;
        } else if (response.status === 200) {
            console.log('   ✅ TURBOPUFFER API KEY IS VALID');
            return true;
        }
    } catch (error) {
        console.log(`   ❌ Network error: ${error.message}`);
        return false;
    }
}

// Test OpenAI directly
async function testOpenAI() {
    console.log('\n3. Testing OpenAI API...');
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEYS.OPENAI_API_KEY}`
            }
        });

        const data = await response.text();
        console.log(`   Status: ${response.status}`);
        
        if (response.status === 401) {
            console.log('   ❌ OPENAI API KEY IS INVALID');
            return false;
        } else if (response.status === 200) {
            console.log('   ✅ OPENAI API KEY IS VALID');
            return true;
        } else {
            console.log(`   Response: ${data.substring(0, 200)}...`);
        }
    } catch (error) {
        console.log(`   ❌ Network error: ${error.message}`);
        return false;
    }
}

async function validateAllKeys() {
    const jinaValid = await testJinaAI();
    const turbopufferValid = await testTurbopuffer();
    const openaiValid = await testOpenAI();
    
    console.log('\n' + '='.repeat(50));
    console.log('API KEY VALIDATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Jina AI: ${jinaValid ? '✅ VALID' : '❌ INVALID'}`);
    console.log(`Turbopuffer: ${turbopufferValid ? '✅ VALID' : '❌ INVALID'}`);
    console.log(`OpenAI: ${openaiValid ? '✅ VALID' : '❌ INVALID'}`);
    
    const validCount = [jinaValid, turbopufferValid, openaiValid].filter(Boolean).length;
    console.log(`\nValid Keys: ${validCount}/3 (${Math.round(validCount/3*100)}%)`);
    
    if (!jinaValid) {
        console.log('\n🚨 CRITICAL: Jina AI key is invalid - this breaks embedding generation');
        console.log('   This explains the 60% API test failure rate');
    }
    
    if (validCount === 3) {
        console.log('\n✅ All API keys are valid - issue must be elsewhere');
    } else {
        console.log(`\n⚠️  ${3-validCount} invalid API key(s) - need replacement`);
    }
}

validateAllKeys().catch(console.error);
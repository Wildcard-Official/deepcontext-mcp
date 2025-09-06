#!/usr/bin/env node

/**
 * Test script to validate both stdio and HTTP transport modes
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log('🧪 Testing Transport Modes\n');

async function testStdioTransport() {
    console.log('1. Testing STDIO Transport (default)...');
    
    const childProcess = spawn('node', ['dist/enhanced-mcp.js'], {
        env: {
            ...process.env,
            JINA_API_KEY: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
            TURBOPUFFER_API_KEY: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
            OPENAI_API_KEY: "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",
            LOG_LEVEL: 'info'
        }
    });
    
    let output = '';
    let errorOutput = '';
    
    childProcess.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    childProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
    });
    
    // Give the process time to start
    await setTimeout(2000);
    
    // Kill the process
    childProcess.kill('SIGTERM');
    
    // Wait for process to exit
    await new Promise((resolve) => {
        childProcess.on('exit', resolve);
    });
    
    console.log('   STDIO Transport Output:');
    if (errorOutput) {
        const lines = errorOutput.split('\n').filter(line => line.trim());
        lines.forEach(line => console.log('   ', line));
        
        if (errorOutput.includes('🚀 Enhanced MCP Server ready') && 
            errorOutput.includes('🔌 Transport: stdio')) {
            console.log('   ✅ STDIO transport started successfully');
        } else {
            console.log('   ❌ STDIO transport failed to start properly');
        }
    } else {
        console.log('   ❌ No output received');
    }
    
    return errorOutput.includes('🚀 Enhanced MCP Server ready');
}

async function testHttpTransport() {
    console.log('\n2. Testing HTTP Transport...');
    
    const childProcess = spawn('node', ['dist/enhanced-mcp.js'], {
        env: {
            ...process.env,
            JINA_API_KEY: "jina_00cde35fcf9945649a67bc6c8397029fxNFysrgXloMnnP1KsRnxPZSVyDAm",
            TURBOPUFFER_API_KEY: "tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2",
            OPENAI_API_KEY: "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",
            LOG_LEVEL: 'info',
            TRANSPORT: 'http',
            PORT: '3001'
        }
    });
    
    let output = '';
    let errorOutput = '';
    
    childProcess.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    childProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
    });
    
    // Give the process more time to start HTTP server
    await setTimeout(3000);
    
    // Test health endpoint
    let healthCheck = false;
    try {
        const response = await fetch('http://localhost:3001/health');
        if (response.ok) {
            const data = await response.json();
            console.log('   Health check response:', JSON.stringify(data, null, 2));
            healthCheck = data.status === 'healthy';
        }
    } catch (error) {
        console.log('   ❌ Health check failed:', error.message);
    }
    
    // Kill the process
    childProcess.kill('SIGTERM');
    
    // Wait for process to exit
    await new Promise((resolve) => {
        childProcess.on('exit', resolve);
    });
    
    console.log('   HTTP Transport Output:');
    if (errorOutput) {
        const lines = errorOutput.split('\n').filter(line => line.trim());
        lines.forEach(line => console.log('   ', line));
        
        if (errorOutput.includes('🚀 Enhanced MCP Server ready') && 
            errorOutput.includes('🔌 Transport: http') &&
            errorOutput.includes('📡 Listening on port 3001')) {
            console.log('   ✅ HTTP transport started successfully');
        } else {
            console.log('   ❌ HTTP transport failed to start properly');
        }
    } else {
        console.log('   ❌ No output received');
    }
    
    if (healthCheck) {
        console.log('   ✅ Health endpoint working');
    } else {
        console.log('   ❌ Health endpoint failed');
    }
    
    return errorOutput.includes('🚀 Enhanced MCP Server ready') && healthCheck;
}

async function runTests() {
    const stdioSuccess = await testStdioTransport();
    const httpSuccess = await testHttpTransport();
    
    console.log('\n📊 Test Results:');
    console.log(`   STDIO Transport: ${stdioSuccess ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   HTTP Transport: ${httpSuccess ? '✅ PASS' : '❌ FAIL'}`);
    
    if (stdioSuccess && httpSuccess) {
        console.log('\n🎉 All transport modes working correctly!');
    } else {
        console.log('\n⚠️  Some transport modes need attention');
    }
}

runTests().catch(console.error);
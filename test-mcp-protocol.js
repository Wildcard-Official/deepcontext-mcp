#!/usr/bin/env node

/**
 * Test that MCP protocol works with clean stdout/stderr separation
 */

import { spawn } from 'child_process';

async function testMcpProtocol() {
    console.log('🧪 Testing MCP Protocol with Clean stdout...\n');
    
    // Start the MCP server
    const mcpProcess = spawn('node', ['dist/enhanced-mcp.js'], {
        env: {
            ...process.env,
            JINA_API_KEY: 'test',
            TURBOPUFFER_API_KEY: 'test', 
            OPENAI_API_KEY: 'test'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    console.log('📊 stderr (logs):');
    mcpProcess.stderr.on('data', (data) => {
        console.log('STDERR:', data.toString().trim());
    });

    // Wait for server startup
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('\n📋 Testing MCP Protocol Messages on stdout...\n');

    // Test initialization
    const initMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: 'test-client', version: '1.0.0' }
        }
    };

    const listToolsMessage = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
    };

    let stdoutData = '';
    mcpProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
    });

    // Send messages
    mcpProcess.stdin.write(JSON.stringify(initMessage) + '\n');
    setTimeout(() => {
        mcpProcess.stdin.write(JSON.stringify(listToolsMessage) + '\n');
    }, 500);

    // Wait for responses
    setTimeout(() => {
        console.log('📤 Raw stdout content:');
        console.log(stdoutData);
        
        console.log('\n🔍 Parsing JSON responses:');
        const lines = stdoutData.trim().split('\n');
        lines.forEach((line, i) => {
            if (line.trim()) {
                try {
                    const response = JSON.parse(line);
                    console.log(`Response ${i + 1}:`, JSON.stringify(response, null, 2));
                } catch (e) {
                    console.log(`❌ Invalid JSON on line ${i + 1}:`, line);
                }
            }
        });

        mcpProcess.kill();
        console.log('\n✅ Protocol Test Completed');
    }, 3000);
}

testMcpProtocol().catch(console.error);
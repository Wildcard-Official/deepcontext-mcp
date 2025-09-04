#!/usr/bin/env node

/**
 * Simple compilation test to check for integration issues
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Testing MCP integration compilation...');

try {
  // Check if TypeScript compilation works
  const tscProcess = spawn('npx', ['tsc', '--noEmit'], {
    stdio: 'inherit',
    cwd: __dirname
  });

  tscProcess.on('close', (code) => {
    if (code === 0) {
      console.log('✅ TypeScript compilation successful');
      console.log('🎉 Integration appears to be set up correctly!');
      
      console.log('\n📋 Next steps:');
      console.log('1. Set JINA_API_KEY environment variable');
      console.log('2. Set TURBOPUFFER_API_KEY environment variable');
      console.log('3. Test with: npm run dev');
      
      process.exit(0);
    } else {
      console.log('❌ TypeScript compilation failed');
      console.log('🔍 Check the error messages above for missing dependencies or type issues');
      process.exit(1);
    }
  });

  tscProcess.on('error', (error) => {
    console.error('❌ Failed to run TypeScript compiler:', error);
    process.exit(1);
  });

} catch (error) {
  console.error('❌ Test failed:', error);
  process.exit(1);
}
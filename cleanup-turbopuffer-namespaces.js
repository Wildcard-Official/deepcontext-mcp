#!/usr/bin/env node

/**
 * Script to clean up old Turbopuffer namespaces
 * This will clear out unused or outdated namespaces from your Turbopuffer account
 */

import * as readline from 'readline';

const TURBOPUFFER_API_KEY = process.env.TURBOPUFFER_API_KEY || 'tpuf_sSODNgba3EjgGSmDUwuopUZbF8P3e8Q2';
const TURBOPUFFER_API_URL = 'https://gcp-us-central1.turbopuffer.com/v2';

// Namespaces to clean up (based on your list)
const NAMESPACES_TO_DELETE = [
    'mcp_1a2bd903',  // 1,307 docs, 6MB
    'mcp_281ba3f5',  // 149 docs, 683KB  
    'mcp_4bdf1f32',  // 238 docs, 1.1MB
    'mcp_ffa9de89'   // 2,100 docs, 9.71MB
];

async function listNamespaces() {
    console.log('📋 Listing all namespaces...\n');
    
    try {
        const response = await fetch(`${TURBOPUFFER_API_URL}/namespaces`, {
            headers: {
                'Authorization': `Bearer ${TURBOPUFFER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to list namespaces: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Current namespaces:', JSON.stringify(data, null, 2));
        return data;
    } catch (error) {
        console.error('❌ Error listing namespaces:', error.message);
        return null;
    }
}

async function deleteNamespace(namespace) {
    console.log(`🗑️ Deleting namespace: ${namespace}`);
    
    try {
        const response = await fetch(`${TURBOPUFFER_API_URL}/namespaces/${namespace}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${TURBOPUFFER_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            console.log(`✅ Successfully deleted namespace: ${namespace}`);
            return true;
        } else {
            const errorText = await response.text();
            console.log(`⚠️ Failed to delete ${namespace}: ${response.status} - ${errorText}`);
            return false;
        }
    } catch (error) {
        console.error(`❌ Error deleting ${namespace}:`, error.message);
        return false;
    }
}

async function cleanupNamespaces() {
    console.log('🧹 Starting Turbopuffer Namespace Cleanup...\n');
    console.log('🔑 Using API Key:', TURBOPUFFER_API_KEY.substring(0, 10) + '...');
    console.log('🌐 API URL:', TURBOPUFFER_API_URL);
    console.log('\n📝 Namespaces to delete:');
    NAMESPACES_TO_DELETE.forEach(ns => console.log(`   - ${ns}`));
    console.log('');
    
    // List current namespaces first
    await listNamespaces();
    
    console.log('\n🚀 Starting deletion process...\n');
    
    let successCount = 0;
    let failCount = 0;
    
    for (const namespace of NAMESPACES_TO_DELETE) {
        const success = await deleteNamespace(namespace);
        if (success) {
            successCount++;
        } else {
            failCount++;
        }
        
        // Small delay between deletions to be nice to the API
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n📊 Cleanup Summary:');
    console.log('━'.repeat(30));
    console.log(`✅ Successfully deleted: ${successCount}`);
    console.log(`❌ Failed to delete: ${failCount}`);
    console.log(`📋 Total processed: ${NAMESPACES_TO_DELETE.length}`);
    
    if (successCount === NAMESPACES_TO_DELETE.length) {
        console.log('\n🎉 All namespaces cleaned up successfully!');
    } else if (failCount > 0) {
        console.log('\n⚠️ Some namespaces could not be deleted. Check the logs above.');
    }
    
    // List namespaces again to confirm
    console.log('\n📋 Final namespace list:');
    await listNamespaces();
}

// Confirmation prompt

function askForConfirmation() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        console.log('⚠️ WARNING: This will permanently delete the following namespaces:');
        NAMESPACES_TO_DELETE.forEach(ns => console.log(`   - ${ns}`));
        console.log('\nThis action cannot be undone!\n');
        
        rl.question('Are you sure you want to proceed? (yes/no): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        });
    });
}

// Main execution
async function main() {
    const confirmed = await askForConfirmation();
    
    if (!confirmed) {
        console.log('❌ Operation cancelled.');
        process.exit(0);
    }
    
    await cleanupNamespaces();
}

// Run directly
main().catch(console.error);
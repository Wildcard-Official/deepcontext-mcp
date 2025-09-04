#!/usr/bin/env node

/**
 * Enhanced MCP Implementation with Natural Language Commands
 * 
 * This integrates the new core architecture with slash-style commands
 * for intuitive interaction with the intelligent context system.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    Tool,
    Resource
} from '@modelcontextprotocol/sdk/types.js';

// Core components
import { IndexingOrchestrator } from './core/indexing/IndexingOrchestrator.js';
// SemanticSearchEngine removed - not used in enhanced MCP flow
import { FileUtils } from './utils/FileUtils.js';
import { Logger } from './utils/Logger.js';

// Standalone MCP implementation for actual API integration
import { StandaloneCodexMcp } from './standalone-mcp-integration.js';

// Types
import type { 
    IndexingRequest, 
    IndexingResult
} from './types/core.js';

interface McpConfig {
    jinaApiKey: string;
    turbopufferApiKey: string;
    openaiApiKey?: string; // Optional - for query enhancement
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

interface SlashCommand {
    name: string;
    description: string;
    aliases: string[];
    handler: (args: string[], context: CommandContext) => Promise<any>;
    examples: string[];
}

interface CommandContext {
    codebasePath?: string;
    namespace?: string;
}

export class EnhancedCodexMcp {
    private server: Server;
    private config: McpConfig;
    private standaloneMcp: StandaloneCodexMcp;
    private indexingOrchestrator: IndexingOrchestrator;
    // searchEngine removed - not used, all search goes through standaloneMcp
    private fileUtils: FileUtils;
    private logger: Logger;
    
    // State management
    private context: CommandContext = {};
    private activeNamespaces: Map<string, string> = new Map(); // path -> namespace
    
    // Command registry
    private commands: Map<string, SlashCommand> = new Map();

    constructor() {
        this.config = this.loadConfig();
        this.logger = new Logger('ENHANCED-MCP', this.config.logLevel);
        this.fileUtils = new FileUtils();
        
        // Initialize integrated standalone MCP for real API calls
        this.standaloneMcp = new StandaloneCodexMcp(this.config);
        
        // Initialize core components (for advanced features)
        this.indexingOrchestrator = new IndexingOrchestrator();
        
        // SearchEngine removed - all functionality handled by standaloneMcp
        
        this.server = new Server(
            {
                name: 'intelligent-context-mcp-enhanced',
                version: '2.0.0',
            },
            {
                capabilities: {
                    tools: {},
                    resources: {}
                }
            }
        );
        
        this.setupSlashCommands();
        this.setupHandlers();
    }

    private loadConfig(): McpConfig {
        return {
            jinaApiKey: process.env.JINA_API_KEY || 'test',
            turbopufferApiKey: process.env.TURBOPUFFER_API_KEY || 'test',
            openaiApiKey: process.env.OPENAI_API_KEY, // For query enhancement
            logLevel: (process.env.LOG_LEVEL as any) || 'info'
        };
    }

    private setupSlashCommands(): void {
        // Index commands
        this.registerCommand({
            name: 'index',
            description: 'Index a codebase with intelligent context extraction',
            aliases: ['idx', 'scan'],
            handler: this.handleIndex.bind(this),
            examples: [
                '/index /path/to/codebase',
                '/idx ~/myproject --force',
                '/scan . --incremental'
            ]
        });

        // Search commands
        this.registerCommand({
            name: 'search',
            description: 'Search codebase with intelligent context and dependency expansion',
            aliases: ['find', 'query', 's'],
            handler: this.handleSearch.bind(this),
            examples: [
                '/search authentication implementation',
                '/find how user sessions work',
                '/s database connection setup --type=function'
            ]
        });

        // Status commands
        this.registerCommand({
            name: 'status',
            description: 'Show indexing status and codebase information',
            aliases: ['stat', 'info'],
            handler: this.handleStatus.bind(this),
            examples: [
                '/status',
                '/info /path/to/codebase',
                '/stat --detailed'
            ]
        });

        // Clear commands
        this.registerCommand({
            name: 'clear',
            description: 'Clear index data for a codebase',
            aliases: ['clean', 'reset'],
            handler: this.handleClear.bind(this),
            examples: [
                '/clear',
                '/clean /path/to/codebase',
                '/reset --confirm'
            ]
        });

        // Context commands
        this.registerCommand({
            name: 'context',
            description: 'Get focused context for specific files or symbols',
            aliases: ['ctx', 'focus'],
            handler: this.handleContext.bind(this),
            examples: [
                '/context src/auth.js',
                '/ctx UserService --with-deps',
                '/focus login function --window=10'
            ]
        });

        // Dependency commands
        this.registerCommand({
            name: 'deps',
            description: 'Analyze dependencies and relationships',
            aliases: ['dependencies', 'relations'],
            handler: this.handleDependencies.bind(this),
            examples: [
                '/deps src/user.js',
                '/dependencies AuthController --reverse',
                '/relations database --graph'
            ]
        });

        // Help command
        this.registerCommand({
            name: 'help',
            description: 'Show available commands and usage',
            aliases: ['h', '?'],
            handler: this.handleHelp.bind(this),
            examples: [
                '/help',
                '/help search',
                '/? index'
            ]
        });
    }

    private registerCommand(command: SlashCommand): void {
        this.commands.set(command.name, command);
        for (const alias of command.aliases) {
            this.commands.set(alias, command);
        }
    }

    private setupHandlers(): void {
        // Tool handlers
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools: Tool[] = [
                {
                    name: 'execute_slash_command',
                    description: 'Execute slash-style commands for intelligent codebase operations',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            command: {
                                type: 'string',
                                description: 'The slash command to execute (e.g., "/index /path/to/codebase", "/search user authentication")'
                            },
                            codebase_path: {
                                type: 'string',
                                description: 'Optional: Set the current codebase path for commands'
                            }
                        },
                        required: ['command']
                    }
                },
                {
                    name: 'natural_language_query',
                    description: 'Natural language interface for codebase exploration and analysis',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Natural language query about the codebase (e.g., "Find all authentication functions", "Show me the user registration flow")'
                            },
                            codebase_path: {
                                type: 'string',
                                description: 'Path to the codebase to query'
                            },
                            focus: {
                                type: 'string',
                                enum: ['functions', 'classes', 'interfaces', 'imports', 'all'],
                                description: 'Focus the search on specific code elements'
                            }
                        },
                        required: ['query']
                    }
                }
            ];

            return { tools };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'execute_slash_command':
                        return await this.executeSlashCommand(
                            (args as any).command, 
                            (args as any).codebase_path
                        );
                    
                    case 'natural_language_query':
                        return await this.handleNaturalLanguageQuery(
                            (args as any).query, 
                            (args as any).codebase_path, 
                            (args as any).focus
                        );
                    
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                this.logger.error('Tool execution failed:', error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        });

        // Resource handlers
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const resources: Resource[] = [
                {
                    uri: 'mcp://codebase-status',
                    name: 'Codebase Status',
                    description: 'Current status of indexed codebases'
                },
                {
                    uri: 'mcp://command-help',
                    name: 'Command Help',
                    description: 'Available slash commands and usage examples'
                }
            ];

            return { resources };
        });

        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;

            switch (uri) {
                case 'mcp://codebase-status':
                    return await this.getCodebaseStatusResource();
                
                case 'mcp://command-help':
                    return await this.getCommandHelpResource();
                
                default:
                    throw new Error(`Unknown resource: ${uri}`);
            }
        });
    }

    private async executeSlashCommand(commandString: string, codebasePath?: string): Promise<any> {
        if (codebasePath) {
            this.context.codebasePath = codebasePath;
        }

        const parsed = this.parseSlashCommand(commandString);
        const command = this.commands.get(parsed.command);

        if (!command) {
            return {
                content: [{
                    type: 'text',
                    text: `Unknown command: ${parsed.command}\nType "/help" to see available commands.`
                }]
            };
        }

        const result = await command.handler(parsed.args, this.context);
        
        return {
            content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }]
        };
    }

    private parseSlashCommand(commandString: string): { command: string; args: string[] } {
        const trimmed = commandString.trim();
        if (!trimmed.startsWith('/')) {
            throw new Error('Commands must start with "/"');
        }

        const parts = trimmed.slice(1).split(/\s+/);
        return {
            command: parts[0] || '',
            args: parts.slice(1)
        };
    }

    // Command handlers
    private async handleIndex(args: string[], context: CommandContext): Promise<string> {
        const path = args[0] || context.codebasePath || process.cwd();
        const force = args.includes('--force');

        this.logger.info(`Indexing codebase: ${path} (force=${force})`);

        try {
            // Use the integrated standalone MCP for real API calls
            const result = await this.standaloneMcp.indexCodebaseIntelligent(path, force);
            
            if (result.success) {
                // Store namespace for future commands
                this.activeNamespaces.set(path, result.namespace);
                this.context.codebasePath = path;
                this.context.namespace = result.namespace;

                return `✅ ${result.message}

📊 **Results:**
- Namespace: \`${result.namespace}\`
- Files processed: ${result.filesProcessed}
- Chunks created: ${result.chunksCreated}
- Processing time: ${result.processingTimeMs}ms

🔍 Ready for intelligent search with \`/search <query>\``;
            } else {
                return `❌ ${result.message}`;
            }
        } catch (error) {
            this.logger.error('Indexing failed:', error);
            return `❌ Indexing failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async handleSearch(args: string[], context: CommandContext): Promise<string> {
        const query = args.join(' ');
        if (!query) {
            return '❌ Search query is required. Usage: /search <query>';
        }

        const codebasePath = context.codebasePath;
        const maxResults = 10;

        try {
            // Use the integrated standalone MCP for real API calls
            const result = await this.standaloneMcp.searchWithIntelligence(query, codebasePath, maxResults);
            
            if (result.success && result.results.length > 0) {
                let output = `🔍 **Found ${result.totalResults} results (${result.searchTimeMs}ms):**\n\n`;
                
                for (const chunk of result.results.slice(0, 5)) {
                    const score = chunk.score ? ` (${chunk.score.toFixed(3)})` : '';
                    output += `**${chunk.relativePath}:${chunk.startLine}-${chunk.endLine}**${score}\n`;
                    output += `\`\`\`${chunk.language}\n${chunk.content.substring(0, 200)}${chunk.content.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
                }

                if (result.results.length > 5) {
                    output += `... and ${result.results.length - 5} more results.\n`;
                }

                return output;
            } else if (result.success) {
                return '🔍 No results found for your query.';
            } else {
                return `❌ ${result.message}`;
            }
        } catch (error) {
            this.logger.error('Search failed:', error);
            return `❌ Search failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async handleStatus(args: string[], context: CommandContext): Promise<string> {
        const path = args[0] || context.codebasePath;
        
        try {
            // Use the integrated standalone MCP for real status
            const result = await this.standaloneMcp.getIndexingStatus(path);
            
            let output = `📊 **Indexing Status:**\n\n`;
            
            if (result.indexedCodebases.length === 0) {
                output += `No codebases indexed yet. Use \`/index <path>\` to start.\n`;
                return output;
            }
            
            output += `**Indexed Codebases (${result.indexedCodebases.length}):**\n`;
            for (const codebase of result.indexedCodebases) {
                output += `- \`${codebase.path}\`\n`;
                output += `  - Namespace: \`${codebase.namespace}\`\n`;
                output += `  - Chunks: ${codebase.totalChunks}\n`;
                output += `  - Indexed: ${codebase.indexedAt}\n\n`;
            }
            
            if (result.currentCodebase) {
                output += `**Current Codebase:**\n`;
                output += `- Path: \`${result.currentCodebase.path}\`\n`;
                output += `- Namespace: \`${result.currentCodebase.namespace}\`\n`;
                output += `- Total chunks: ${result.currentCodebase.totalChunks}\n`;
                
                if (result.incrementalStats) {
                    output += `- Index type: ${result.incrementalStats.indexingMethod}\n`;
                    output += `- Last indexed: ${result.incrementalStats.lastIndexed}\n`;
                }
            }
            
            return output;
        } catch (error) {
            return `❌ Status check failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async handleClear(args: string[], context: CommandContext): Promise<string> {
        const path = args[0] || context.codebasePath;
        const confirm = args.includes('--confirm');

        if (!confirm) {
            const target = path ? path : 'all codebases';
            return `⚠️  This will clear all index data for ${target}.\nUse "/clear ${args.join(' ')} --confirm" to proceed.`;
        }

        try {
            // Use the integrated standalone MCP for real clearing
            const result = await this.standaloneMcp.clearIndex(path);
            
            if (result.success) {
                // Update local state
                if (path) {
                    this.activeNamespaces.delete(path);
                    if (context.codebasePath === path) {
                        this.context = {};
                    }
                } else {
                    this.activeNamespaces.clear();
                    this.context = {};
                }
                
                return `✅ ${result.message}\nCleared namespaces: ${result.clearedNamespaces.join(', ')}`;
            } else {
                return `❌ ${result.message}`;
            }
        } catch (error) {
            return `❌ Clear failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async handleContext(args: string[], context: CommandContext): Promise<string> {
        const target = args[0];
        if (!target) {
            return '❌ Context target is required. Usage: /context <file-or-symbol>';
        }

        const withDeps = args.includes('--with-deps');
        const windowSize = this.extractWindowSize(args) || 5;

        return `📋 Context for ${target} (window=${windowSize}, deps=${withDeps})\n[Context functionality pending integration]`;
    }

    private async handleDependencies(args: string[], context: CommandContext): Promise<string> {
        const target = args[0];
        if (!target) {
            return '❌ Dependency target is required. Usage: /deps <file-or-symbol>';
        }

        const reverse = args.includes('--reverse');
        const graph = args.includes('--graph');

        return `🔗 Dependencies for ${target} (reverse=${reverse}, graph=${graph})\n[Dependency analysis pending integration]`;
    }

    private async handleHelp(args: string[], context: CommandContext): Promise<string> {
        const commandName = args[0];
        
        if (commandName) {
            const command = this.commands.get(commandName);
            if (!command) {
                return `❌ Unknown command: ${commandName}`;
            }
            
            return this.formatCommandHelp(command);
        }

        return this.formatAllCommandsHelp();
    }

    private async handleNaturalLanguageQuery(query: string, codebasePath?: string, focus?: string): Promise<any> {
        // Convert natural language to appropriate slash commands
        const interpretation = this.interpretNaturalLanguage(query, focus);
        
        if (codebasePath) {
            this.context.codebasePath = codebasePath;
        }

        // Execute the interpreted command
        return await this.executeSlashCommand(interpretation.command, codebasePath);
    }

    private interpretNaturalLanguage(query: string, focus?: string): { command: string; confidence: number } {
        const lowerQuery = query.toLowerCase();
        
        // Index-related queries
        if (lowerQuery.includes('index') || lowerQuery.includes('scan') || lowerQuery.includes('build index')) {
            return { command: '/index', confidence: 0.9 };
        }
        
        // Search-related queries
        if (lowerQuery.includes('find') || lowerQuery.includes('search') || lowerQuery.includes('show me') || lowerQuery.includes('where is')) {
            const searchQuery = query.replace(/^(find|search|show me|where is)\s*/i, '');
            return { command: `/search ${searchQuery}`, confidence: 0.8 };
        }
        
        // Status queries
        if (lowerQuery.includes('status') || lowerQuery.includes('info') || lowerQuery.includes('what\'s indexed')) {
            return { command: '/status', confidence: 0.9 };
        }
        
        // Default to search
        return { command: `/search ${query}`, confidence: 0.5 };
    }

    // Formatting helper methods removed - unused legacy code

    private formatCommandHelp(command: SlashCommand): string {
        let help = `**/${command.name}** - ${command.description}\n\n`;
        
        if (command.aliases.length > 0) {
            help += `**Aliases:** ${command.aliases.map(a => `/${a}`).join(', ')}\n\n`;
        }
        
        help += '**Examples:**\n';
        for (const example of command.examples) {
            help += `- \`${example}\`\n`;
        }
        
        return help;
    }

    private formatAllCommandsHelp(): string {
        let help = `# 🚀 Intelligent Context MCP - Command Reference\n\n`;
        help += `Execute commands with natural language or slash syntax:\n\n`;
        
        const mainCommands = ['index', 'search', 'status', 'context', 'deps', 'clear', 'help'];
        
        for (const cmdName of mainCommands) {
            const command = this.commands.get(cmdName);
            if (command && command.name === cmdName) {
                help += `**/${command.name}** - ${command.description}\n`;
            }
        }
        
        help += `\n💡 **Natural Language Examples:**\n`;
        help += `- "Index my codebase at /path/to/project"\n`;
        help += `- "Find authentication functions"\n`;
        help += `- "Show me the user registration flow"\n`;
        help += `- "What's the status of my index?"\n`;
        
        return help;
    }

    // Utility methods
    private extractWindowSize(args: string[]): number | null {
        const windowArg = args.find(arg => arg.startsWith('--window='));
        return windowArg ? parseInt(windowArg.split('=')[1]) : null;
    }

    private async getCodebaseStatusResource(): Promise<any> {
        const status = {
            activeNamespaces: Array.from(this.activeNamespaces.entries()),
            currentContext: this.context
        };

        return {
            contents: [{
                type: 'text',
                text: JSON.stringify(status, null, 2)
            }]
        };
    }

    private async getCommandHelpResource(): Promise<any> {
        const helpText = this.formatAllCommandsHelp();
        
        return {
            contents: [{
                type: 'text',
                text: helpText
            }]
        };
    }

    // Mock methods removed - no longer needed since SearchEngine was removed

    async run(): Promise<void> {
        this.logger.info('Starting Enhanced Intelligent Context MCP Server...');
        
        // Show configuration status
        const capabilities = {
            queryEnhancement: !!this.config.openaiApiKey,
            reranking: !!this.config.jinaApiKey,
            vectorSearch: !!this.config.turbopufferApiKey,
            localBM25: true
        };
        
        this.logger.info('🔧 Capabilities:', capabilities);
        
        if (!this.config.openaiApiKey) {
            this.logger.warn('⚠️  OpenAI API key not provided - query enhancement will be disabled');
            this.logger.info('💡 Set OPENAI_API_KEY environment variable to enable query enhancement');
        }
        
        if (!this.config.jinaApiKey || this.config.jinaApiKey === 'test') {
            this.logger.warn('⚠️  Jina API key not provided - result reranking will be disabled');
            this.logger.info('💡 Set JINA_API_KEY environment variable to enable result reranking');
        }
        
        // Initialize the standalone MCP integration
        await this.standaloneMcp.initialize();
        
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        
        this.logger.info('🚀 Enhanced MCP Server ready with slash commands and natural language interface!');
        this.logger.info(`✨ Query Enhancement: ${capabilities.queryEnhancement ? '✅ Enabled' : '❌ Disabled'}`);
        this.logger.info(`🔄 Result Reranking: ${capabilities.reranking ? '✅ Enabled' : '❌ Disabled'}`);
        this.logger.info('📝 Local BM25 Search: ✅ Always Available');
    }
}

// Auto-run when called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = new EnhancedCodexMcp();
    server.run().catch(console.error);
}
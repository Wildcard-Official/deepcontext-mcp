/**
 * MCP Protocol Service
 * Handles Model Context Protocol server setup, tool registration, and request handling
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

import { Logger } from '../utils/Logger.js';

export interface McpToolHandler {
    (args: any): Promise<{
        content: Array<{
            type: 'text';
            text: string;
        }>;
    }>;
}

export interface McpResourceHandler {
    (uri: string): Promise<{
        contents: Array<{
            type: 'text';
            text: string;
        }>;
    }>;
}

export interface McpServerConfig {
    name: string;
    version: string;
    capabilities?: {
        tools?: any;
        resources?: any;
    };
}

export class McpProtocolService {
    private server: Server;
    private logger: Logger;
    private serverConfig: McpServerConfig;
    private tools: Map<string, McpToolHandler> = new Map();
    private resources: Map<string, McpResourceHandler> = new Map();
    private toolDefinitions: Tool[] = [];
    private resourceDefinitions: Resource[] = [];

    constructor(config: McpServerConfig, loggerName: string = 'McpProtocolService') {
        this.logger = new Logger(loggerName);
        this.serverConfig = config;
        
        this.server = new Server(
            {
                name: config.name,
                version: config.version,
            },
            {
                capabilities: config.capabilities || {
                    tools: {},
                    resources: {}
                }
            }
        );
        
        this.setupBaseHandlers();
    }

    /**
     * Register a tool with the MCP server
     */
    registerTool(toolDefinition: Tool, handler: McpToolHandler): void {
        this.toolDefinitions.push(toolDefinition);
        this.tools.set(toolDefinition.name, handler);
        this.logger.debug(`Registered tool: ${toolDefinition.name}`);
    }

    /**
     * Register a resource with the MCP server
     */
    registerResource(resourceDefinition: Resource, handler: McpResourceHandler): void {
        this.resourceDefinitions.push(resourceDefinition);
        this.resources.set(resourceDefinition.uri, handler);
        this.logger.debug(`Registered resource: ${resourceDefinition.uri}`);
    }

    /**
     * Register default intelligent context tools
     */
    registerIntelligentContextTools(handlers: {
        indexCodebase: McpToolHandler;
        searchCodebase: McpToolHandler;
        getIndexingStatus: McpToolHandler;
        clearIndex: McpToolHandler;
    }): void {
        // Index Codebase Tool
        this.registerTool({
            name: 'index_codebase',
            description: 'Index a codebase for intelligent search and analysis',
            inputSchema: {
                type: 'object',
                properties: {
                    codebase_path: {
                        type: 'string',
                        description: 'Path to the codebase to index'
                    },
                    force_reindex: {
                        type: 'boolean',
                        description: 'Force reindexing even if already indexed',
                        default: false
                    }
                },
                required: ['codebase_path']
            }
        }, handlers.indexCodebase);

        // Search Codebase Tool
        this.registerTool({
            name: 'search_codebase',
            description: `
Search the indexed codebase using natural language or specific terms with intelligent hybrid search (vector + BM25).

🎯 **When to Use**:
This tool should be used for all code-related searches in this project:
- **Code search**: Find specific functions, classes, or implementations
- **Context gathering**: Get relevant code context before making changes  
- **Architecture understanding**: Understand how systems like hybrid search are implemented
- **Feature analysis**: Analyze existing functionality and patterns

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return an error indicating indexing is required first.
- Use the index_codebase tool to index the codebase before searching.
`,
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (natural language or specific terms)'
                    },
                    codebase_path: {
                        type: 'string',
                        description: 'Path to the codebase to search (optional if only one indexed)'
                    },
                    max_results: {
                        type: 'number',
                        description: 'Maximum number of results to return',
                        default: 10
                    }
                },
                required: ['query']
            }
        }, handlers.searchCodebase);

        // Get Indexing Status Tool
        this.registerTool({
            name: 'get_indexing_status',
            description: 'Get the indexing status of codebases',
            inputSchema: {
                type: 'object',
                properties: {
                    codebase_path: {
                        type: 'string',
                        description: 'Optional: Get status for specific codebase'
                    }
                }
            }
        }, handlers.getIndexingStatus);

        // Clear Index Tool
        this.registerTool({
            name: 'clear_index',
            description: 'Clear index data for a codebase',
            inputSchema: {
                type: 'object',
                properties: {
                    codebase_path: {
                        type: 'string',
                        description: 'Path to the codebase to clear (optional to clear all)'
                    }
                }
            }
        }, handlers.clearIndex);
    }

    /**
     * Register default intelligent context resources
     */
    registerIntelligentContextResources(handlers: {
        codebaseStatus: McpResourceHandler;
    }): void {
        this.registerResource({
            uri: 'mcp://codebase-status',
            name: 'Codebase Status',
            description: 'Current status of indexed codebases'
        }, handlers.codebaseStatus);
    }

    /**
     * Setup base MCP handlers
     */
    private setupBaseHandlers(): void {
        // List Tools Handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: this.toolDefinitions };
        });

        // Call Tool Handler
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                const handler = this.tools.get(name);
                if (!handler) {
                    throw new Error(`Unknown tool: ${name}`);
                }

                this.logger.debug(`Executing tool: ${name}`, args);
                const result = await handler(args);
                this.logger.debug(`Tool ${name} completed successfully`);
                
                return result;
            } catch (error) {
                this.logger.error(`Tool ${name} failed:`, error);
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`
                    }]
                };
            }
        });

        // List Resources Handler
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return { resources: this.resourceDefinitions };
        });

        // Read Resource Handler
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;

            try {
                const handler = this.resources.get(uri);
                if (!handler) {
                    throw new Error(`Unknown resource: ${uri}`);
                }

                this.logger.debug(`Reading resource: ${uri}`);
                const result = await handler(uri);
                this.logger.debug(`Resource ${uri} read successfully`);
                
                return result;
            } catch (error) {
                this.logger.error(`Resource ${uri} read failed:`, error);
                throw error;
            }
        });
    }

    /**
     * Run the MCP server with stdio transport
     */
    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        this.logger.info(`Starting MCP server: ${this.serverConfig.name}`);
        
        try {
            await this.server.connect(transport);
            this.logger.info('MCP server connected and running');
        } catch (error) {
            this.logger.error('Failed to start MCP server:', error);
            throw error;
        }
    }

    /**
     * Get server information
     */
    getServerInfo(): {
        name: string;
        version: string;
        toolsCount: number;
        resourcesCount: number;
        tools: string[];
        resources: string[];
    } {
        return {
            name: this.serverConfig.name,
            version: this.serverConfig.version,
            toolsCount: this.toolDefinitions.length,
            resourcesCount: this.resourceDefinitions.length,
            tools: this.toolDefinitions.map(t => t.name),
            resources: this.resourceDefinitions.map(r => r.uri)
        };
    }

    /**
     * Check if a tool is registered
     */
    hasToolRegistered(toolName: string): boolean {
        return this.tools.has(toolName);
    }

    /**
     * Check if a resource is registered
     */
    hasResourceRegistered(resourceUri: string): boolean {
        return this.resources.has(resourceUri);
    }

    /**
     * Get all registered tool names
     */
    getRegisteredTools(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Get all registered resource URIs
     */
    getRegisteredResources(): string[] {
        return Array.from(this.resources.keys());
    }
}
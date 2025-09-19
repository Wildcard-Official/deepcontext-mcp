<p align="center">
  <img alt="DeepContext Logo" src="https://github.com/user-attachments/assets/6dd1b4a4-5ce3-41cb-acc0-b3eed32d5f8e" width="500" height="296">
</p>

<h1 align="center">Smarter Context for Large Codebases</h1>

<p align="center">
  <a href="https://github.com/Wildcard-Official/deepcontext-mcp/stargazers">
    <img src="https://img.shields.io/github/stars/Wildcard-Official/deepcontext-mcp?style=social" alt="GitHub stars">
  </a>
  <a href="https://www.npmjs.com/package/@wildcard-ai/deepcontext">
    <img src="https://img.shields.io/npm/v/@wildcard-ai/deepcontext" alt="NPM Version">
  </a>
  <a href="https://join.slack.com/t/wildcard-community/shared_invite/zt-3dslre0yd-H8M_Ftsf8AJoB6nP~wVIpg">
    <img src="https://img.shields.io/badge/Slack-join-blueviolet?logo=slack" alt="Slack Community">
  </a>
  <a href="https://discord.gg/7VU6HKq7cZ">
    <img src="https://img.shields.io/discord/1334616501436682405?style=flat&logo=discord&logoColor=white&label=discord&color=7289DA" alt="Discord">
  </a>
  <a href="https://x.com/wildcard_ai">
    <img src="https://img.shields.io/twitter/follow/wildcard_ai?style=social" alt="Twitter Follow">
  </a>
</p>

DeepContext is an MCP server that adds symbol-aware semantic search to Codex CLI, Claude Code, and other agents, giving them more precise context of even the largest codebases.

## Why DeepContext MCP?

Most coding agents use grep based search that match exact text, these searches miss semantically related code and fill context windows with irrelevant results. Large codebases amplify this problem, where text search returns hundreds of matches that quickly overwhelm conversation capacity.  This leads to slow completions, more hallucinations, and lower success rates.

DeepContext provides agents with intelligent search that preserves context windows by finding only relevant code chunks.

- **Semantic accuracy**: Matches code by meaning and relationships rather than text patterns, finding related functions across files that keyword search misses.

- **Reduced token usage**: Returns precise code chunks instead of every file containing your search terms, preserving conversation context windows and reducing costs.

- **Search speed**: Searches code immediately through pre-indexed data for instant file discovery.

## Quickstart

1. Visit the Wildcard [DeepContext](https://wild-card.ai/deepcontext) page
2. Click "Generate API Key"
3. Copy your API key
4. Paste installation command for your MCP client

**Claude Code:**
```bash
claude mcp add deepcontext \
  -e WILDCARD_API_KEY=your-wildcard-api-key \
  -- npx @wildcard-ai/deepcontext@latest
```

**Codex:**
```toml
# Add to ~/.codex/config.toml
[mcp_servers.deepcontext]
command = "npx"
args = ["-y", "@wildcard-ai/deepcontext@latest"]
env = { "WILDCARD_API_KEY" = "your-wildcard-api-key" }
```

## MCP Tools

#### `index_codebase`
Creates a searchable index of your codebase for semantic search.

#### `search_codebase`
Finds relevant code using natural language or keyword queries.

#### `get_indexing_status`
Shows indexing status and file counts for your codebases.

#### `clear_index`
Removes all indexed data for a codebase.

## Architecture

**MCP Integration Flow**
- Coding Agent communicates with DeepContext through the Model Context Protocol
- MCP server receives requests, validates parameters, and routes to appropriate core components
- For long-running operations like indexing, spawns detached background processes to prevent timeouts
  - Background workers handle large codebases without blocking MCP channel // Reword

**AST-Based Parsing**
- Tree-sitter parsers analyze source code to build Abstract Syntax Trees
  - Python, TypeScript, and JavaScript language grammars for accurate parsing
  - Semantic node identification for functions, classes, interfaces, and modules
- Symbol extraction identifies functions, classes, interfaces, types, variables, and constants
  - Scope analysis determines local vs exported vs global visibility
  - Parameter and return type extraction for function signatures
- Import/export analysis maps module dependencies and cross-file relationships
- Creates chunks at semantic boundaries rather than arbitrary line or token splits
  - Large file handling through range-based parsing with overlapping windows

**Hybrid Search with Reranking**
- Search operates in three stages
  - Hybrid search combines vector similarity and BM25 full-text search
  - Jina reranker-v2 for final relevance optimization
- Vector similarity finds semantically related code using embeddings
  - Jina text embeddings generate 1024-dimension vectors for code chunks
- BM25 performs traditional keyword matching for exact terms
  - Full-text indexing enables precise identifier and comment matching
- Results fused using configurable weights, then reordered by Jina reranker

**Incremental Indexing**
- Uses file modification times and content hashes to track changes
  - SHA-256 hashing detects content modifications at byte level
- Only reprocesses files with different hashes during reindexing
  - Avoids unnecessary parsing and embedding generation for unchanged files

**Content Filtering**
- Scores files based on extension patterns, path components, and content analysis
  - Language detection and file type classification for processing decisions
- Excludes test files, generated code, minified files, and build outputs during indexing
  - Pattern matching against common test frameworks and build tool outputs
- Filters documentation and configuration files to focus on source code

## Self Hosting

Self-hosting requires code modifications to integrate directly with vector storage and embedding providers, as the current implementation uses the Wildcard API backend.

**Prerequisites**
- Node.js 20+ for ES module support and performance optimizations
- Turbopuffer API key for vector storage and hybrid search operations
- Jina AI API key for text embeddings and reranking services

**Setup**
```bash
git clone https://github.com/Wildcard-Official/deepcontext-mcp.git
cd deepcontext
npm install
npm run build
```

**Integration**
```bash
claude mcp add deepcontext-local \
  -e TURBOPUFFER_API_KEY=your-turbopuffer-key \
  -e JINA_API_KEY=your-jina-key \
  -- node /path/to/deepcontext/dist/standalone-mcp-integration.js
```

## Contributing

Thanks for your interest! We’re currently not accepting external contributions as we’re an early-stage startup focused on rapid iteration. We may open things up in the future — feel free to ⭐ the repo to stay in the loop.

## License

Licensed under the Apache License.

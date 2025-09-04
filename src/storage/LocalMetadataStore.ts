/**
 * Local Metadata Store - SQLite-based storage for code chunk metadata
 * Supports BM25 full-text search and metadata queries without remote dependencies
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger.js';

export interface CodeChunkMetadata {
  id: string;
  codebasePath: string;
  filePath: string;
  relativePath: string;
  content: string;
  symbols: string[]; // JSON array as string
  language: string;
  startLine: number;
  endLine: number;
  fileSize: number;
  lastModified: number;
  imports?: string[];
  dependencies?: string[];
  indexed: boolean;
  indexedAt?: number;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  fileTypes?: string[];
  minScore?: number;
}

export interface FTSResult {
  id: string;
  score: number;
  metadata: CodeChunkMetadata;
}

export class LocalMetadataStore {
  private db: Database.Database;
  private logger = new Logger('LocalMetadataStore');

  constructor(dbPath?: string) {
    const defaultPath = path.join(process.cwd(), '.mcp', 'metadata.db');
    const finalDbPath = dbPath || defaultPath;
    
    // Ensure directory exists
    fs.mkdirSync(path.dirname(finalDbPath), { recursive: true });
    
    this.db = new Database(finalDbPath);
    this.initializeSchema();
    this.logger.info('LocalMetadataStore initialized', { dbPath: finalDbPath });
  }

  private initializeSchema(): void {
    // Main metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,
        codebase_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content TEXT NOT NULL,
        symbols TEXT, -- JSON array as string
        language TEXT,
        start_line INTEGER,
        end_line INTEGER,
        file_size INTEGER,
        last_modified INTEGER,
        imports TEXT, -- JSON array as string
        dependencies TEXT, -- JSON array as string
        indexed BOOLEAN DEFAULT false,
        indexed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);

    // FTS5 table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
        id,
        content,
        symbols,
        file_path,
        language,
        content='code_chunks',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_fts_insert AFTER INSERT ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(id, content, symbols, file_path, language)
        VALUES (new.id, new.content, new.symbols, new.file_path, new.language);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_fts_delete AFTER DELETE ON code_chunks BEGIN
        DELETE FROM code_chunks_fts WHERE id = old.id;
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_fts_update AFTER UPDATE ON code_chunks BEGIN
        UPDATE code_chunks_fts 
        SET content = new.content, symbols = new.symbols, file_path = new.file_path, language = new.language
        WHERE id = new.id;
      END
    `);

    // Indexes for performance
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_codebase_path ON code_chunks(codebase_path)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_path ON code_chunks(file_path)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_language ON code_chunks(language)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_indexed ON code_chunks(indexed)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_last_modified ON code_chunks(last_modified)`);

    this.logger.debug('Database schema initialized');
  }

  /**
   * Store or update code chunk metadata
   */
  async upsertChunk(metadata: CodeChunkMetadata): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks (
        id, codebase_path, file_path, relative_path, content, symbols,
        language, start_line, end_line, file_size, last_modified,
        imports, dependencies, indexed, indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `);

    stmt.run(
      metadata.id,
      metadata.codebasePath,
      metadata.filePath,
      metadata.relativePath,
      metadata.content,
      JSON.stringify(metadata.symbols),
      metadata.language,
      metadata.startLine,
      metadata.endLine,
      metadata.fileSize,
      metadata.lastModified,
      JSON.stringify(metadata.imports || []),
      JSON.stringify(metadata.dependencies || []),
      metadata.indexed,
      metadata.indexedAt || Date.now()
    );
  }

  /**
   * Batch upsert multiple chunks (more efficient)
   */
  async upsertChunks(chunks: CodeChunkMetadata[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks (
        id, codebase_path, file_path, relative_path, content, symbols,
        language, start_line, end_line, file_size, last_modified,
        imports, dependencies, indexed, indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `);

    const transaction = this.db.transaction((chunks: CodeChunkMetadata[]) => {
      for (const metadata of chunks) {
        stmt.run(
          metadata.id,
          metadata.codebasePath,
          metadata.filePath,
          metadata.relativePath,
          metadata.content,
          JSON.stringify(metadata.symbols),
          metadata.language,
          metadata.startLine,
          metadata.endLine,
          metadata.fileSize,
          metadata.lastModified,
          JSON.stringify(metadata.imports || []),
          JSON.stringify(metadata.dependencies || []),
          metadata.indexed,
          metadata.indexedAt || Date.now()
        );
      }
    });

    transaction(chunks);
    this.logger.debug('Batch upserted chunks', { count: chunks.length });
  }

  /**
   * Full-text search using SQLite FTS5 (BM25-like scoring)
   */
  async searchFullText(
    codebasePath: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<FTSResult[]> {
    const limit = options.limit || 10;
    const offset = options.offset || 0;

    // Build FTS query - escape special characters
    const ftsQuery = query.replace(/['"]/g, '""');

    let sql = `
      SELECT 
        c.*,
        rank as score
      FROM code_chunks_fts fts
      JOIN code_chunks c ON c.id = fts.id
      WHERE fts MATCH ? AND c.codebase_path = ?
    `;

    const params: any[] = [ftsQuery, codebasePath];

    // Add file type filter
    if (options.fileTypes && options.fileTypes.length > 0) {
      const placeholders = options.fileTypes.map(() => '?').join(',');
      sql += ` AND c.language IN (${placeholders})`;
      params.push(...options.fileTypes);
    }

    sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      score: -row.score, // FTS5 rank is negative, flip for consistent scoring
      metadata: this.rowToMetadata(row)
    }));
  }

  /**
   * Get metadata for specific chunk IDs (for vector search enrichment)
   */
  async getChunksByIds(ids: string[]): Promise<Map<string, CodeChunkMetadata>> {
    if (ids.length === 0) {
      return new Map();
    }

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM code_chunks WHERE id IN (${placeholders})
    `);

    const rows = stmt.all(...ids) as any[];
    const result = new Map<string, CodeChunkMetadata>();

    for (const row of rows) {
      result.set(row.id, this.rowToMetadata(row));
    }

    return result;
  }

  /**
   * Get all chunks for a codebase
   */
  async getCodebaseChunks(
    codebasePath: string,
    options: SearchOptions = {}
  ): Promise<CodeChunkMetadata[]> {
    let sql = `SELECT * FROM code_chunks WHERE codebase_path = ?`;
    const params: any[] = [codebasePath];

    if (options.fileTypes && options.fileTypes.length > 0) {
      const placeholders = options.fileTypes.map(() => '?').join(',');
      sql += ` AND language IN (${placeholders})`;
      params.push(...options.fileTypes);
    }

    sql += ` ORDER BY file_path, start_line`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
      
      if (options.offset) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => this.rowToMetadata(row));
  }

  /**
   * Delete all chunks for a codebase
   */
  async deleteCodebase(codebasePath: string): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM code_chunks WHERE codebase_path = ?`);
    const result = stmt.run(codebasePath);
    
    this.logger.info('Deleted codebase chunks', { 
      codebasePath, 
      deletedCount: result.changes 
    });
    
    return result.changes;
  }

  /**
   * Get codebase statistics
   */
  async getCodebaseStats(codebasePath: string): Promise<{
    totalChunks: number;
    indexedChunks: number;
    languages: Record<string, number>;
    lastIndexed?: number;
  }> {
    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM code_chunks WHERE codebase_path = ?
    `);
    const indexedStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM code_chunks WHERE codebase_path = ? AND indexed = true
    `);
    const languagesStmt = this.db.prepare(`
      SELECT language, COUNT(*) as count 
      FROM code_chunks 
      WHERE codebase_path = ? 
      GROUP BY language
    `);
    const lastIndexedStmt = this.db.prepare(`
      SELECT MAX(indexed_at) as last_indexed 
      FROM code_chunks 
      WHERE codebase_path = ? AND indexed = true
    `);

    const totalResult = totalStmt.get(codebasePath) as { count: number };
    const indexedResult = indexedStmt.get(codebasePath) as { count: number };
    const languageResults = languagesStmt.all(codebasePath) as { language: string; count: number }[];
    const lastIndexedResult = lastIndexedStmt.get(codebasePath) as { last_indexed: number | null };

    const languages: Record<string, number> = {};
    for (const result of languageResults) {
      languages[result.language] = result.count;
    }

    return {
      totalChunks: totalResult.count,
      indexedChunks: indexedResult.count,
      languages,
      lastIndexed: lastIndexedResult.last_indexed || undefined
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    this.logger.info('Database connection closed');
  }

  private rowToMetadata(row: any): CodeChunkMetadata {
    return {
      id: row.id,
      codebasePath: row.codebase_path,
      filePath: row.file_path,
      relativePath: row.relative_path,
      content: row.content,
      symbols: JSON.parse(row.symbols || '[]'),
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      fileSize: row.file_size,
      lastModified: row.last_modified,
      imports: JSON.parse(row.imports || '[]'),
      dependencies: JSON.parse(row.dependencies || '[]'),
      indexed: Boolean(row.indexed),
      indexedAt: row.indexed_at
    };
  }
}
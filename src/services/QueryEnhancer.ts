/**
 * Query Enhancer - Standalone Implementation
 * Improves search queries using OpenAI or Jina AI for better code search results
 */

import { Logger } from '../utils/Logger.js';

export interface QueryEnhancementOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface EnhancedQuery {
  original: string;
  enhanced: string;
  provider: string;
}

export class QueryEnhancer {
  private logger = new Logger('QueryEnhancer');

  constructor(
    private openaiApiKey?: string
  ) {
    if (!openaiApiKey) {
      throw new Error('OpenAI API key is required for query enhancement');
    }
  }

  async enhance(
    query: string, 
    options: QueryEnhancementOptions = {}
  ): Promise<EnhancedQuery> {
    // Skip enhancement for short queries
    if (query.trim().split(' ').length < 3) {
      return { original: query, enhanced: query, provider: 'none' };
    }
    
    try {
      const enhanced = await this.enhanceWithOpenAI(query, options);
      return { original: query, enhanced, provider: 'openai' };
    } catch (error) {
      this.logger.warn('OpenAI query enhancement failed, using original', { 
        query: query.substring(0, 50), 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return { original: query, enhanced: query, provider: 'fallback' };
    }
  }

  private async enhanceWithOpenAI(
    query: string, 
    options: QueryEnhancementOptions
  ): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a code search expert. Rewrite user queries into better search keywords for finding relevant code. Focus on technical terms, function names, and programming concepts. Keep responses concise.'
          },
          {
            role: 'user',
            content: `Rewrite this code search query for better results: "${query}"`
          }
        ],
        max_tokens: options.maxTokens || 100,
        temperature: options.temperature || 0
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const enhanced = data.choices?.[0]?.message?.content?.trim();
    
    return enhanced && enhanced !== query ? enhanced : query;
  }

  isAvailable(): { openai: boolean } {
    return {
      openai: !!this.openaiApiKey
    };
  }
}
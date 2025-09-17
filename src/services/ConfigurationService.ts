/**
 * Configuration Service
 * Handles application configuration, environment variables, and service validation
 */

import { Logger } from '../utils/Logger.js';

export interface McpConfig {
    wildcardApiKey: string;
    jinaApiKey: string;
    turbopufferApiKey: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ServiceCapabilities {
    reranking: boolean;
    vectorSearch: boolean;
    embedding: boolean;
}

export interface ConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    capabilities: ServiceCapabilities;
}

export interface ConfigurationOptions {
    validateOnLoad?: boolean;
    logConfigurationStatus?: boolean;
    allowTestKeys?: boolean;
}

export class ConfigurationService {
    private logger: Logger;
    private config: McpConfig;
    private validationResult: ConfigValidationResult | null = null;

    constructor(
        configOverride?: Partial<McpConfig>,
        options: ConfigurationOptions = {},
        loggerName: string = 'ConfigurationService'
    ) {
        this.logger = new Logger(loggerName);
        this.config = this.loadConfig(configOverride);
        
        if (options.validateOnLoad !== false) {
            this.validationResult = this.validateConfiguration(options.allowTestKeys !== false);
        }
        
        if (options.logConfigurationStatus !== false) {
            this.logConfigurationStatus();
        }
    }

    /**
     * Load configuration from environment variables and overrides
     */
    private loadConfig(override?: Partial<McpConfig>): McpConfig {
        const envLogLevel = process.env.LOG_LEVEL;
        const validLogLevel: 'debug' | 'info' | 'warn' | 'error' =
            envLogLevel === 'debug' || envLogLevel === 'info' ||
            envLogLevel === 'warn' || envLogLevel === 'error'
                ? envLogLevel
                : 'info';

        const baseConfig: McpConfig = {
            wildcardApiKey: process.env.WILDCARD_API_KEY || 'test',
            jinaApiKey: process.env.JINA_API_KEY || 'test',
            turbopufferApiKey: process.env.TURBOPUFFER_API_KEY || 'test',
            logLevel: validLogLevel
        };
        
        const finalConfig = { ...baseConfig, ...override };
        
        this.logger.debug('Configuration loaded', {
            hasJinaKey: !!finalConfig.jinaApiKey,
            hasTurbopufferKey: !!finalConfig.turbopufferApiKey,
            logLevel: finalConfig.logLevel
        });
        
        return finalConfig;
    }

    /**
     * Get the current configuration
     */
    getConfig(): Readonly<McpConfig> {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    updateConfig(updates: Partial<McpConfig>, revalidate: boolean = true): void {
        this.config = { ...this.config, ...updates };
        
        if (revalidate) {
            this.validationResult = this.validateConfiguration();
        }
        
        this.logger.info('Configuration updated', {
            updatedFields: Object.keys(updates),
            isValid: this.validationResult?.isValid
        });
    }

    /**
     * Validate the current configuration
     */
    validateConfiguration(allowTestKeys: boolean = true): ConfigValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check required keys
        if (!this.config.wildcardApiKey) {
            errors.push('Wildcard API key is required. Get it from https://wild-card.ai/code-context-mcp');
        }

        if (!this.config.wildcardApiKey && !this.config.jinaApiKey) {
            errors.push('Jina API key is required');
        }

        if (!this.config.wildcardApiKey && !this.config.turbopufferApiKey) {
            errors.push('Turbopuffer API key is required');
        }

        // OpenAI API key no longer required

        // Validate log level
        const validLogLevels = ['debug', 'info', 'warn', 'error'];
        if (!validLogLevels.includes(this.config.logLevel)) {
            warnings.push(`Invalid log level: ${this.config.logLevel}. Using 'info' instead.`);
            this.config.logLevel = 'info';
        }

        // Determine capabilities
        const capabilities: ServiceCapabilities = {
            reranking: !!(this.config.jinaApiKey && this.config.jinaApiKey !== 'test'),
            vectorSearch: !!(this.config.turbopufferApiKey && this.config.turbopufferApiKey !== 'test'),
            embedding: !!(this.config.jinaApiKey && this.config.jinaApiKey !== 'test')
        };

        const result: ConfigValidationResult = {
            isValid: errors.length === 0,
            errors,
            warnings,
            capabilities
        };

        this.validationResult = result;
        return result;
    }

    /**
     * Get the last validation result
     */
    getValidationResult(): ConfigValidationResult | null {
        return this.validationResult;
    }

    /**
     * Check if configuration is valid
     */
    isValid(): boolean {
        return this.validationResult?.isValid ?? false;
    }

    /**
     * Get service capabilities
     */
    getCapabilities(): ServiceCapabilities {
        if (!this.validationResult) {
            this.validationResult = this.validateConfiguration();
        }
        return { ...this.validationResult.capabilities };
    }

    /**
     * Check if a specific capability is available
     */
    hasCapability(capability: keyof ServiceCapabilities): boolean {
        const capabilities = this.getCapabilities();
        return capabilities[capability];
    }

    /**
     * Get configuration for specific services
     */
    getJinaConfig(): { apiKey: string; isAvailable: boolean } {
        return {
            apiKey: this.config.jinaApiKey,
            isAvailable: !!(this.config.jinaApiKey && this.config.jinaApiKey !== 'test')
        };
    }

    getTurbopufferConfig(): { apiKey: string; isAvailable: boolean } {
        return {
            apiKey: this.config.turbopufferApiKey,
            isAvailable: !!(this.config.turbopufferApiKey && this.config.turbopufferApiKey !== 'test')
        };
    }


    /**
     * Log configuration status to console
     */
    logConfigurationStatus(): void {
        const capabilities = this.getCapabilities();
        
        console.error('\n🔧 Intelligent Context MCP Configuration:');
        console.error('=' .repeat(50));
        console.error(`📊 Log Level: ${this.config.logLevel.toUpperCase()}`);
        console.error(`🔑 Jina API: ${this.config.jinaApiKey !== 'test' ? '✅ Configured' : '⚠️ Test Key'}`);
        console.error(`🗄️ Turbopuffer: ${this.config.turbopufferApiKey !== 'test' ? '✅ Configured' : '⚠️ Test Key'}`);
        console.error('\n🚀 Available Capabilities:');
        console.error(`🔄 Result Reranking: ${capabilities.reranking ? '✅ Enabled' : '❌ Disabled'}`);
        console.error(`🔍 Vector Search: ${capabilities.vectorSearch ? '✅ Enabled' : '❌ Disabled'}`);
        console.error(`📐 Embeddings: ${capabilities.embedding ? '✅ Enabled' : '❌ Disabled'}`);

        // Show warnings if any
        if (this.validationResult?.warnings.length) {
            console.error('\n⚠️ Configuration Warnings:');
            this.validationResult.warnings.forEach(warning => {
                console.error(`   • ${warning}`);
            });
        }

        // Show limitations with test keys
        if (!capabilities.reranking || !capabilities.vectorSearch) {
            console.error('\n💡 To enable full functionality:');
            if (!capabilities.reranking) {
                console.error('   • Set JINA_API_KEY environment variable');
            }
            if (!capabilities.vectorSearch) {
                console.error('   • Set TURBOPUFFER_API_KEY environment variable');
            }
        }
        console.error('=' .repeat(50));
    }

    /**
     * Get configuration summary for status reporting
     */
    getConfigurationSummary(): {
        isValid: boolean;
        capabilities: ServiceCapabilities;
        keyStatus: {
            jina: 'configured' | 'test' | 'missing';
            turbopuffer: 'configured' | 'test' | 'missing';
        };
        errors: string[];
        warnings: string[];
    } {
        const validation = this.validationResult || this.validateConfiguration();
        
        return {
            isValid: validation.isValid,
            capabilities: validation.capabilities,
            keyStatus: {
                jina: !this.config.jinaApiKey ? 'missing' :
                      this.config.jinaApiKey === 'test' ? 'test' : 'configured',
                turbopuffer: !this.config.turbopufferApiKey ? 'missing' :
                            this.config.turbopufferApiKey === 'test' ? 'test' : 'configured'
            },
            errors: validation.errors,
            warnings: validation.warnings
        };
    }

    /**
     * Create a masked version of the config for logging (hides API keys)
     */
    getMaskedConfig(): Record<string, any> {
        return {
            jinaApiKey: this.maskApiKey(this.config.jinaApiKey),
            turbopufferApiKey: this.maskApiKey(this.config.turbopufferApiKey),
            logLevel: this.config.logLevel
        };
    }

    /**
     * Mask API key for safe logging
     */
    private maskApiKey(key: string): string {
        if (!key || key === 'test') return key;
        if (key.length <= 8) return '*'.repeat(key.length);
        return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
    }

    /**
     * Reset configuration to defaults
     */
    resetToDefaults(): void {
        this.config = this.loadConfig();
        this.validationResult = this.validateConfiguration();
        this.logger.info('Configuration reset to defaults');
    }

    /**
     * Check if configuration has changed since last validation
     */
    needsRevalidation(): boolean {
        return this.validationResult === null;
    }

    /**
     * Force revalidation of configuration
     */
    revalidate(allowTestKeys: boolean = true): ConfigValidationResult {
        this.validationResult = this.validateConfiguration(allowTestKeys);
        return this.validationResult;
    }
}
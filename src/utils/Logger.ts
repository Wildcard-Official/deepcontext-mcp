/**
 * Logger - Simple logging utility for MCP server
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
    private level: LogLevel;
    private prefix: string;

    constructor(prefix: string = 'MCP', level: LogLevel = 'info') {
        this.prefix = prefix;
        this.level = level;
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.level);
    }

    private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
        const timestamp = new Date().toISOString();
        const formatted = args.length > 0 ? `${message} ${args.map(a => JSON.stringify(a)).join(' ')}` : message;
        return `[${timestamp}] [${this.prefix}] [${level.toUpperCase()}] ${formatted}`;
    }

    debug(message: string, ...args: any[]): void {
        if (this.shouldLog('debug')) {
            process.stderr.write(this.formatMessage('debug', message, ...args) + '\n');
        }
    }

    info(message: string, ...args: any[]): void {
        if (this.shouldLog('info')) {
            process.stderr.write(this.formatMessage('info', message, ...args) + '\n');
        }
    }

    warn(message: string, ...args: any[]): void {
        if (this.shouldLog('warn')) {
            process.stderr.write(this.formatMessage('warn', message, ...args) + '\n');
        }
    }

    error(message: string, ...args: any[]): void {
        if (this.shouldLog('error')) {
            process.stderr.write(this.formatMessage('error', message, ...args) + '\n');
        }
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    createChild(childPrefix: string): Logger {
        return new Logger(`${this.prefix}:${childPrefix}`, this.level);
    }
}
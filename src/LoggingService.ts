import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVELS: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
};

export class LoggingService implements vscode.OutputChannel {
    private readonly channel: vscode.OutputChannel;
    private level: number = LEVELS.info;

    readonly name = 'Mago';

    constructor() {
        this.channel = vscode.window.createOutputChannel('Mago');
    }

    setLevel(level: LogLevel): void {
        this.level = LEVELS[level] ?? LEVELS.info;
    }

    logError(message: string, ...args: unknown[]): void {
        this.emit('error', message, args);
    }

    logWarn(message: string, ...args: unknown[]): void {
        this.emit('warn', message, args);
    }

    logInfo(message: string, ...args: unknown[]): void {
        this.emit('info', message, args);
    }

    logDebug(message: string, ...args: unknown[]): void {
        this.emit('debug', message, args);
    }

    logTrace(message: string, ...args: unknown[]): void {
        this.emit('trace', message, args);
    }

    private emit(level: LogLevel, message: string, args: unknown[]): void {
        if (LEVELS[level] > this.level) {
            return;
        }
        const timestamp = new Date().toISOString();
        const extra = args.length > 0 ? ` ${args.map((a) => JSON.stringify(a)).join(' ')}` : '';
        this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}${extra}`);
    }

    // --- vscode.OutputChannel passthrough (required for vscode-languageclient) ---

    append(value: string): void {
        this.channel.append(value);
    }

    appendLine(value: string): void {
        this.channel.appendLine(value);
    }

    clear(): void {
        this.channel.clear();
    }

    show(preserveFocus?: boolean): void;
    show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
    show(_columnOrPreserve?: vscode.ViewColumn | boolean, _preserveFocus?: boolean): void {
        this.channel.show();
    }

    hide(): void {
        this.channel.hide();
    }

    dispose(): void {
        this.channel.dispose();
    }

    replace(value: string): void {
        this.channel.replace(value);
    }
}

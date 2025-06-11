import * as vscode from 'vscode';

/**
 * 时间统计信息
 */
export interface TimeStatistics {
    startTime: number; // 纠错开始时间（毫秒）
    lastParagraphTime: number; // 上次段落纠错耗时（毫秒）
    totalElapsedTime: number; // 总耗时（毫秒）
    processedCharacters: number; // 已处理字符数
    totalCharacters: number; // 总字符数
    averageCharactersPerSecond: number; // 平均每秒处理字符数
    estimatedRemainingTime: number; // 预估剩余时间（毫秒）
    paragraphTimes: number[]; // 各段落纠错耗时记录
}

/**
 * 时间统计服务
 * 用于跟踪和计算纠错过程中的时间统计信息
 */
export class TimeStatisticsService {
    private editorTimeStats: Map<string, TimeStatistics> = new Map();

    /**
     * 开始时间统计
     */
    public startTimeTracking(editor: vscode.TextEditor, totalCharacters: number): void {
        const uri = editor.document.uri.toString();
        const now = Date.now();
        
        const timeStats: TimeStatistics = {
            startTime: now,
            lastParagraphTime: 0,
            totalElapsedTime: 0,
            processedCharacters: 0,
            totalCharacters: totalCharacters,
            averageCharactersPerSecond: 0,
            estimatedRemainingTime: 0,
            paragraphTimes: []
        };
        
        this.editorTimeStats.set(uri, timeStats);
    }

    /**
     * 记录段落纠错开始时间
     */
    public startParagraphTimer(editor: vscode.TextEditor): number {
        return Date.now();
    }

    /**
     * 记录段落纠错完成，更新统计信息
     */
    public recordParagraphCompletion(
        editor: vscode.TextEditor, 
        paragraphStartTime: number, 
        paragraphCharacters: number
    ): void {
        const uri = editor.document.uri.toString();
        const timeStats = this.editorTimeStats.get(uri);
        
        if (!timeStats) {
            return;
        }

        const now = Date.now();
        const paragraphTime = now - paragraphStartTime;
        
        // 更新统计信息
        timeStats.lastParagraphTime = paragraphTime;
        timeStats.totalElapsedTime = now - timeStats.startTime;
        timeStats.processedCharacters += paragraphCharacters;
        timeStats.paragraphTimes.push(paragraphTime);
        
        // 计算平均处理速度（字符/秒）
        if (timeStats.totalElapsedTime > 0) {
            timeStats.averageCharactersPerSecond = 
                (timeStats.processedCharacters / timeStats.totalElapsedTime) * 1000;
        }
        
        // 计算预估剩余时间
        const remainingCharacters = timeStats.totalCharacters - timeStats.processedCharacters;
        if (timeStats.averageCharactersPerSecond > 0 && remainingCharacters > 0) {
            timeStats.estimatedRemainingTime = 
                (remainingCharacters / timeStats.averageCharactersPerSecond) * 1000;
        } else {
            timeStats.estimatedRemainingTime = 0;
        }
        
        this.editorTimeStats.set(uri, timeStats);
    }

    /**
     * 获取时间统计信息
     */
    public getTimeStatistics(editor: vscode.TextEditor): TimeStatistics | undefined {
        const uri = editor.document.uri.toString();
        return this.editorTimeStats.get(uri);
    }

    /**
     * 格式化时间显示（毫秒转为可读格式）
     */
    public formatTime(milliseconds: number): string {
        if (milliseconds < 1000) {
            return `${Math.round(milliseconds)}ms`;
        }
        
        const seconds = milliseconds / 1000;
        if (seconds < 60) {
            return `${seconds.toFixed(1)}s`;
        }
        
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}m ${remainingSeconds}s`;
    }

    /**
     * 格式化速度显示（字符/秒）
     */
    public formatSpeed(charactersPerSecond: number): string {
        if (charactersPerSecond < 1) {
            return `${Math.round(charactersPerSecond * 1000)}字符/分钟`;
        }
        return `${Math.round(charactersPerSecond)}字符/秒`;
    }    /**
     * 获取详细的时间统计信息（用于tooltip显示）
     */    public getDetailedTimeInfo(editor: vscode.TextEditor): string {
        const timeStats = this.getTimeStatistics(editor);
        
        if (!timeStats) {
            return '暂无时间统计信息';
        }

        // 使用等宽字体显示格式，手动计算空格实现右对齐
        const formatLine = (label: string, value: string, totalWidth: number = 24) => {
            const spaces = ' '.repeat(Math.max(1, totalWidth - label.length - value.length));
            return `${label}${spaces}${value}`;
        };

        let info = `**时间统计：**\n`;
        info += formatLine('总耗时:', this.formatTime(timeStats.totalElapsedTime)) + '\n';
        info += formatLine('上次段落耗时:', this.formatTime(timeStats.lastParagraphTime)) + '\n';
        
        if (timeStats.averageCharactersPerSecond > 0) {
            info += formatLine('平均速度:', this.formatSpeed(timeStats.averageCharactersPerSecond)) + '\n';
        }
        
        if (timeStats.estimatedRemainingTime > 0) {
            info += formatLine('预估剩余时间:', this.formatTime(timeStats.estimatedRemainingTime));
        }

        return info;
    }

    /**
     * 完成时间统计，返回最终统计信息
     */
    public completeTimeTracking(editor: vscode.TextEditor): TimeStatistics | undefined {
        const uri = editor.document.uri.toString();
        const timeStats = this.editorTimeStats.get(uri);
        
        if (timeStats) {
            // 更新最终的总耗时
            timeStats.totalElapsedTime = Date.now() - timeStats.startTime;
            timeStats.estimatedRemainingTime = 0;
        }
        
        return timeStats;
    }

    /**
     * 清理编辑器的时间统计信息
     */
    public clearTimeStatistics(editor: vscode.TextEditor): void {
        const uri = editor.document.uri.toString();
        this.editorTimeStats.delete(uri);
    }    /**
     * 获取最终统计摘要（用于最终花费详情显示）
     */    public getFinalTimeSummary(editor: vscode.TextEditor): string {
        const timeStats = this.getTimeStatistics(editor);
        
        if (!timeStats) {
            return '';
        }

        // 使用相同的格式化函数实现右对齐
        const formatLine = (label: string, value: string, totalWidth: number = 20) => {
            const spaces = ' '.repeat(Math.max(1, totalWidth - label.length - value.length));
            return `${label}${spaces}${value}`;
        };

        let summary = `\n**时间统计：**\n`;
        summary += formatLine('总纠错时间:', this.formatTime(timeStats.totalElapsedTime)) + '\n';
        summary += formatLine('总字符数:', timeStats.processedCharacters.toString());

        return summary;
    }

    /**
     * 清理已关闭编辑器的时间统计
     */
    public cleanupClosedEditors(): void {
        const openUris = new Set(
            vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString())
        );
        
        for (const uri of this.editorTimeStats.keys()) {
            if (!openUris.has(uri)) {
                this.editorTimeStats.delete(uri);
            }
        }
    }

    /**
     * 释放所有资源
     */
    public dispose(): void {
        this.editorTimeStats.clear();
    }
}

import * as vscode from 'vscode';
import { EditorStateManager } from './editorStateManager';
import { ConfigManager } from '../config/configManager';
import { ApiUsage } from './apiService';
import { TimeStatisticsService } from './timeStatisticsService';

/**
 * 成本计算服务 - 负责计算和管理API使用成本
 */
export class CostService {
    private configManager: ConfigManager;
    private editorStateManager: EditorStateManager;
    private timeStatisticsService: TimeStatisticsService;

    constructor(
        configManager: ConfigManager, 
        editorStateManager: EditorStateManager,
        timeStatisticsService: TimeStatisticsService
    ) {
        this.configManager = configManager;
        this.editorStateManager = editorStateManager;
        this.timeStatisticsService = timeStatisticsService;
    }

    /**
     * 计算并更新花费信息
     */
    public calculateAndUpdateCost(editor: vscode.TextEditor, usage: ApiUsage): void {
        const config = this.configManager.getConfig();

        // 费率计算：配置的价格是每百万token的价格，转换为每token的价格
        const inputRate = config.inputTokenPrice / 1_000_000;  // 元/token
        const outputRate = config.outputTokenPrice / 1_000_000;  // 元/token

        // 计算费用
        const inputCost = usage.prompt_tokens * inputRate;
        const outputCost = usage.completion_tokens * outputRate;
        const totalCost = inputCost + outputCost;

        // 更新累计花费
        this.editorStateManager.updateCostInfo(
            editor,
            usage.prompt_tokens,
            usage.completion_tokens,
            totalCost,
            config.currency
        );

        console.log(`[Cost] 输入: ${usage.prompt_tokens} tokens (${inputCost.toFixed(6)} ${config.currency}), 输出: ${usage.completion_tokens} tokens (${outputCost.toFixed(6)} ${config.currency}), 本次: ${totalCost.toFixed(6)} ${config.currency}`);
    }

    /**
     * 获取编辑器的成本信息
     */
    public getCostInfo(editor: vscode.TextEditor) {
        return this.editorStateManager.getCostInfo(editor);
    }

    /**
     * 获取包含时间统计的详细花费信息
     */
    public getDetailedCostInfo(editor: vscode.TextEditor): string {
        const costInfo = this.editorStateManager.getCostInfo(editor);
        const config = this.configManager.getConfig();
        
        if (costInfo.totalCost === 0) {
            return '暂无花费信息';
        }

        const currencySymbol = costInfo.currency === '元' ? '￥' : '$';
        const inputTokens = costInfo.totalInputTokens;
        const outputTokens = costInfo.totalOutputTokens;
        const totalTokens = inputTokens + outputTokens;

        // 计算输入和输出花费
        const inputRate = config.inputTokenPrice / 1_000_000;
        const outputRate = config.outputTokenPrice / 1_000_000;
        const inputCost = inputTokens * inputRate;
        const outputCost = outputTokens * outputRate;

        let details = `花费详情：
输入tokens: ${inputTokens.toString().padStart(12)}
输出tokens: ${outputTokens.toString().padStart(12)}
总tokens: ${totalTokens.toString().padStart(12)}
输入花费: ${(currencySymbol + inputCost.toFixed(6)).padStart(12)}
输出花费: ${(currencySymbol + outputCost.toFixed(6)).padStart(12)}
总计: ${(currencySymbol + costInfo.totalCost.toFixed(6)).padStart(12)}`;

        // 添加时间统计信息
        const timeSummary = this.timeStatisticsService.getFinalTimeSummary(editor);
        if (timeSummary) {
            details += timeSummary;
        }

        return details;
    }

    /**
     * 重置编辑器的成本信息
     */
    public resetCostInfo(editor: vscode.TextEditor) {
        this.editorStateManager.resetCostInfo(editor);
    }
}

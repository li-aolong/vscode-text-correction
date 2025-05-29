import * as vscode from 'vscode';
import { EditorStateManager } from './editorStateManager';
import { ConfigManager } from '../config/configManager';
import { ApiUsage } from './apiService';

/**
 * 成本计算服务 - 负责计算和管理API使用成本
 */
export class CostService {
    private configManager: ConfigManager;
    private editorStateManager: EditorStateManager;

    constructor(configManager: ConfigManager, editorStateManager: EditorStateManager) {
        this.configManager = configManager;
        this.editorStateManager = editorStateManager;
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
     * 重置编辑器的成本信息
     */
    public resetCostInfo(editor: vscode.TextEditor) {
        this.editorStateManager.resetCostInfo(editor);
    }
}

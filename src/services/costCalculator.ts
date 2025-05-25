import { ConfigManager } from '../config/configManager';

export class CostCalculator {
    constructor(private configManager: ConfigManager) {}

    public estimateCost(text: string): string {
        if (!text.trim()) {
            return this.formatCurrency(0);
        }

        const config = this.configManager.getConfig();

        // 使用新的token估算方法
        const tokens = this.estimateTokensFromText(text);
        const estimatedInputTokens = tokens.input;
        const estimatedOutputTokens = tokens.output;

        // 计算费用
        const inputCost = (estimatedInputTokens / 1000000) * config.inputTokenCostPerMillion;
        const outputCost = (estimatedOutputTokens / 1000000) * config.outputTokenCostPerMillion;
        const totalCost = inputCost + outputCost;

        return this.formatCurrency(totalCost);
    }

    private formatCurrency(amount: number): string {
        const config = this.configManager.getConfig();

        // 格式化数字，保留4位小数，并将单位放在数字后面
        const formattedAmount = amount.toFixed(4);
        return `${formattedAmount}${config.costUnit}`;
    }

    /**
     * 估算文本的token数量
     * 英文按4个字符1个token，中文按1.8个字符1个token
     */
    private estimateTokensFromText(text: string): { input: number; output: number } {
        // 移除多余的空白字符
        const cleanText = text.trim();

        // 分别计算中文字符和英文字符
        const chineseChars = (cleanText.match(/[\u4e00-\u9fff]/g) || []).length;
        const englishChars = cleanText.replace(/[\u4e00-\u9fff]/g, '').length;

        // 英文字符：4个字符 ≈ 1个token
        // 中文字符：1.8个字符 ≈ 1个token
        const englishTokens = Math.ceil(englishChars / 4);
        const chineseTokens = Math.ceil(chineseChars / 1.8);

        const estimatedInputTokens = chineseTokens + englishTokens;
        const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 1.1); // 假设输出比输入多10%

        return {
            input: estimatedInputTokens,
            output: estimatedOutputTokens
        };
    }

    public estimateTokens(text: string): { input: number; output: number } {
        return this.estimateTokensFromText(text);
    }
}

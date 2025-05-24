import { ConfigManager } from '../config/configManager';

export class CostCalculator {
    constructor(private configManager: ConfigManager) {}

    public estimateCost(text: string): string {
        if (!text.trim()) {
            return this.formatCurrency(0);
        }

        const config = this.configManager.getConfig();
        
        // 简单的token估算：大约4个字符 = 1个token（中文可能更少）
        const estimatedInputTokens = Math.ceil(text.length / 3);
        const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 1.1); // 假设输出比输入多10%

        // 计算费用（单位：元）
        const inputCost = (estimatedInputTokens / 1000000) * config.inputTokenCostPerMillion;
        const outputCost = (estimatedOutputTokens / 1000000) * config.outputTokenCostPerMillion;
        const totalCost = inputCost + outputCost;

        return this.formatCurrency(totalCost);
    }

    private formatCurrency(amount: number): string {
        const config = this.configManager.getConfig();
        
        if (config.currency === 'USD') {
            const usdAmount = amount / config.exchangeRate;
            return `$${usdAmount.toFixed(4)}`;
        } else {
            return `¥${amount.toFixed(4)}`;
        }
    }

    public estimateTokens(text: string): { input: number; output: number } {
        const estimatedInputTokens = Math.ceil(text.length / 3);
        const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 1.1);
        
        return {
            input: estimatedInputTokens,
            output: estimatedOutputTokens
        };
    }
}

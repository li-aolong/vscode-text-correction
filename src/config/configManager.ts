import * as vscode from 'vscode';

export interface CorrectionConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    prompt: string;
    timeout: number; // 新增 timeout 属性，单位毫秒
    // 花费配置
    inputTokenPrice: number; // 输入token价格
    outputTokenPrice: number; // 输出token价格
    currency: string; // 货币单位
}

export class ConfigManager {
    private config: CorrectionConfig;

    constructor() {
        this.config = this.loadConfig();
    }

    private loadConfig(): CorrectionConfig {
        const vsconfig = vscode.workspace.getConfiguration('textCorrection');

        return {
            apiKey: vsconfig.get('apiKey', ''),
            baseUrl: vsconfig.get('baseUrl', 'https://api.openai.com/v1'),
            model: vsconfig.get('model', ''),
            prompt: vsconfig.get('prompt', '# 输入文本\n{user_content}\n\n---\n对以上输入文本进行检错并纠正，以JSON格式输出：\n1. 如果没有错误，返回 {"result": true, "corrected_text": null}\n2. 如果有错误，返回 {"result": false, "corrected_text": "纠正后的文本"}'),
            timeout: vsconfig.get('requestTimeout', 60000), // 从配置中读取 timeout，默认60秒
            // 花费配置
            inputTokenPrice: vsconfig.get('inputTokenPrice', 2), // 默认输入价格：10元/百万token
            outputTokenPrice: vsconfig.get('outputTokenPrice', 8), // 默认输出价格：30元/百万token
            currency: vsconfig.get('currency', '元') // 默认货币单位
        };
    }

    public reloadConfig(): void {
        this.config = this.loadConfig();
    }

    public getConfig(): CorrectionConfig {
        return { ...this.config };
    }

    public validateConfig(): string[] {
        const errors: string[] = [];

        if (!this.config.apiKey.trim()) {
            errors.push('API密钥未设置，请在设置中配置 textCorrection.apiKey');
        }

        if (!this.config.baseUrl.trim()) {
            errors.push('API服务地址未设置，请在设置中配置 textCorrection.baseUrl');
        }

        if (!this.config.model.trim()) {
            errors.push('模型名称未设置，请在设置中配置 textCorrection.model');
        }

        if (!this.config.prompt.trim()) {
            errors.push('纠错提示词未设置，请在设置中配置 textCorrection.prompt');
        }

        return errors;
    }
}

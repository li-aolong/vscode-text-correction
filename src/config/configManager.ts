import * as vscode from 'vscode';

export interface CorrectionConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    inputTokenCostPerMillion: number;
    outputTokenCostPerMillion: number;
    prompt: string;
    costUnit: string;
    timeout: number; // 新增 timeout 属性，单位毫秒
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
            inputTokenCostPerMillion: vsconfig.get('inputTokenCostPerMillion', 2),
            outputTokenCostPerMillion: vsconfig.get('outputTokenCostPerMillion', 8),
            prompt: vsconfig.get('prompt', '# 输入文本\n{user_content}\n\n---\n对以上输入文本进行检错并纠正，以JSON格式输出：\n1. 如果没有错误，返回 {"result": true, "corrected_text": null}\n2. 如果有错误，返回 {"result": false, "corrected_text": "纠正后的文本"}'),
            costUnit: vsconfig.get('costUnit', '元'),
            timeout: vsconfig.get('requestTimeout', 60000) // 从配置中读取 timeout，默认60秒
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

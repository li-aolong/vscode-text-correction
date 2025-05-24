import * as vscode from 'vscode';

export interface CorrectionConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    inputTokenCostPerMillion: number;
    outputTokenCostPerMillion: number;
    prompt: string;
    currency: 'CNY' | 'USD';
    exchangeRate: number;
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
            model: vsconfig.get('model', 'gpt-3.5-turbo'),
            inputTokenCostPerMillion: vsconfig.get('inputTokenCostPerMillion', 1.5),
            outputTokenCostPerMillion: vsconfig.get('outputTokenCostPerMillion', 2.0),
            prompt: vsconfig.get('prompt', '请对以下文本进行纠错，保持原意不变，只修正语法、拼写和标点错误：'),
            currency: vsconfig.get('currency', 'CNY') as 'CNY' | 'USD',
            exchangeRate: vsconfig.get('exchangeRate', 7.0),
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
            errors.push('API密钥不能为空');
        }
        
        if (!this.config.baseUrl.trim()) {
            errors.push('API服务地址不能为空');
        }
        
        if (!this.config.model.trim()) {
            errors.push('模型名称不能为空');
        }

        return errors;
    }
}

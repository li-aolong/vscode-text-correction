import axios, { AxiosError } from 'axios';
import { ConfigManager } from '../config/configManager';

export interface ApiUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface CorrectionResponse {
    result: boolean;
    corrected_text: string | null;
}

export interface ApiResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    usage?: ApiUsage;
}

/**
 * API服务类 - 负责与AI服务通信
 */
export class ApiService {
    private configManager: ConfigManager;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
    }

    /**
     * 调用API进行文本纠正
     */
    public async correctText(text: string): Promise<{ correctedText: string; usage?: ApiUsage }> {
        const config = this.configManager.getConfig();

        // 构建发送给API的完整prompt
        const fullPrompt = config.prompt.replace('{user_content}', text);

        try {
            const requestPayload = {
                model: config.model,
                messages: [
                    {
                        role: 'user',
                        content: fullPrompt
                    }
                ],
                temperature: 0.7
            };

            const response = await axios.post(
                `${config.baseUrl}/chat/completions`,
                requestPayload,
                {
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: config.timeout || 10000 // 使用配置的超时或默认值
                }
            );

            const responseContent = response.data.choices[0].message.content.trim();
            const usage = response.data.usage; // 获取usage信息

            try {
                const jsonContent = this.extractJsonFromResponse(responseContent);
                const correctionResult: CorrectionResponse = JSON.parse(jsonContent);

                // 如果没有错误（result为true），返回原文本
                if (correctionResult.result === true || correctionResult.corrected_text === null) {
                    return { correctedText: text, usage };
                }

                // 如果有错误，返回纠正后的文本
                return { correctedText: correctionResult.corrected_text || text, usage };

            } catch (parseError) {
                console.error(`API parse error:`, parseError instanceof Error ? parseError.message : String(parseError));
                return { correctedText: text, usage };
            }

        } catch (error) {
            if (error instanceof AxiosError) {
                throw new Error(`API请求失败: ${error.response?.data?.error?.message || error.message}`);
            }
            if (error instanceof Error) {
                throw new Error(`API请求失败: ${error.message}`);
            }
            throw new Error('API请求失败: 未知错误');
        }
    }

    /**
     * 从API响应中提取JSON内容
     */
    private extractJsonFromResponse(content: string): string {
        // 移除可能的空白字符
        content = content.trim();

        // 处理Markdown代码块格式: ```json {...} ```
        const markdownJsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
        if (markdownJsonMatch) {
            return markdownJsonMatch[1].trim();
        }

        // 处理单行代码块格式: `{...}`
        const inlineCodeMatch = content.match(/`([^`]+)`/);
        if (inlineCodeMatch) {
            return inlineCodeMatch[1].trim();
        }

        // 尝试提取JSON对象 (从第一个{到最后一个})
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return jsonMatch[0];
        }

        // 如果都没有匹配到，返回原始内容
        return content;
    }
}

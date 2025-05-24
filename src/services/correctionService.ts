import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { ConfigManager } from '../config/configManager';
import { DiffManager } from '../diff/diffManager';

interface CorrectionResponse {
    result: boolean;
    corrected_text: string | null;
}

export class CorrectionService {
    private configManager: ConfigManager;
    private diffManager: DiffManager | undefined;
    private isCancelled = false;
    // 原始文档内容，用于撤销操作
    public originalDocumentContent: string = '';

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
    }

    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    public async correctFullText(
        editor: vscode.TextEditor, 
        progressCallback?: (current: number, total: number) => void
    ): Promise<void> {
        const config = this.configManager.getConfig();
        const errors = this.configManager.validateConfig();
        
        if (errors.length > 0) {
            throw new Error(`配置错误: ${errors.join(', ')}`);
        }

        // 清除之前的差异记录
        if (this.diffManager) {
            this.diffManager.clearChanges();
        }

        this.isCancelled = false;
        
        // 保存原始文档内容，用于后续可能的撤销操作
        this.originalDocumentContent = editor.document.getText();
        
        const paragraphs = this.splitIntoParagraphs(this.originalDocumentContent);

        for (let i = 0; i < paragraphs.length; i++) {
            if (this.isCancelled) {
                break;
            }

            // 更新进度
            if (progressCallback) {
                progressCallback(i + 1, paragraphs.length);
            }

            const paragraph = paragraphs[i];
            if (paragraph.content.trim()) {
                try {
                    const correctedText = await this.correctParagraph(paragraph.content);
                    
                    // 只有当文本发生变化时才记录差异并应用修改
                    if (correctedText !== paragraph.content) {
                        await this.applyCorrection(editor, paragraph, correctedText);
                        
                        // 记录差异
                        if (this.diffManager) {
                            const startPos = new vscode.Position(paragraph.startLine, 0);
                            const endPos = new vscode.Position(paragraph.endLine, editor.document.lineAt(paragraph.endLine).text.length);
                            const range = new vscode.Range(startPos, endPos);
                            this.diffManager.addChange(range, paragraph.content, correctedText);
                        }
                    }
                    
                } catch (error) {
                    vscode.window.showErrorMessage(`段落 ${i + 1} 纠错失败: ${error}`);
                }
            }
        }

        // 纠错完成后显示差异导航按钮
        if (this.diffManager && this.diffManager.hasChanges()) {
            // this.showDiffNavigationMessage();
            this.diffManager.showGlobalActionButtons(); 
        }
    }

    // private showDiffNavigationMessage(): void {
    //     vscode.window.showInformationMessage(
    //         '纠错完成！发现修改内容，请选择处理方式。',
    //         '接受全部',
    //         '拒绝全部'
    //     ).then(selection => {
    //         if (selection === '接受全部' && this.diffManager) {
    //             this.diffManager.acceptAllChanges();
    //         } else if (selection === '拒绝全部' && this.diffManager) {
    //             this.diffManager.rejectAllChanges();
    //         }
    //     });
    // }

    public cancelCorrection(): void {
        this.isCancelled = true;
    }

    private splitIntoParagraphs(text: string): Array<{content: string, startLine: number, endLine: number}> {
        const lines = text.split('\n');
        const paragraphs: Array<{content: string, startLine: number, endLine: number}> = [];
        
        let currentParagraph = '';
        let startLine = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.trim() === '') {
                if (currentParagraph.trim()) {
                    paragraphs.push({
                        content: currentParagraph,
                        startLine: startLine,
                        endLine: i - 1
                    });
                    currentParagraph = '';
                }
                startLine = i + 1;
            } else {
                if (currentParagraph === '') {
                    startLine = i;
                }
                currentParagraph += (currentParagraph ? '\n' : '') + line;
            }
        }
        
        // 处理最后一个段落
        if (currentParagraph.trim()) {
            paragraphs.push({
                content: currentParagraph,
                startLine: startLine,
                endLine: lines.length - 1
            });
        }
        
        return paragraphs;
    }

    private async correctParagraph(text: string): Promise<string> {
        const config = this.configManager.getConfig();
        
        try {
            const response = await axios.post(
                `${config.baseUrl}/chat/completions`,
                {
                    model: config.model,
                    messages: [
                        {
                            role: 'user',
                            content: config.prompt.replace('{user_content}', text)
                        }
                    ],
                    temperature: 0.7
                },
                {
                    headers: {
                        'Authorization': `Bearer ${config.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );

            const responseContent = response.data.choices[0].message.content.trim();
            
            try {
                const jsonContent = this.extractJsonFromResponse(responseContent);
                const correctionResult: CorrectionResponse = JSON.parse(jsonContent);
                
                // 如果没有错误（result为true），返回原文本
                if (correctionResult.result === true || correctionResult.corrected_text === null) {
                    return text;
                }
                
                // 如果有错误，返回纠正后的文本
                return correctionResult.corrected_text || text;
                
            } catch (parseError) {
                console.error('解析JSON响应失败:', parseError);
                console.error('原始响应:', responseContent);
                // 如果JSON解析失败，返回原文本
                return text;
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

    private async applyCorrection(
        editor: vscode.TextEditor, 
        paragraph: {content: string, startLine: number, endLine: number}, 
        correctedText: string
    ): Promise<void> {
        const startPos = new vscode.Position(paragraph.startLine, 0);
        const endPos = new vscode.Position(paragraph.endLine, editor.document.lineAt(paragraph.endLine).text.length);
        const range = new vscode.Range(startPos, endPos);

        await editor.edit(editBuilder => {
            editBuilder.replace(range, correctedText);
        });
    }
}

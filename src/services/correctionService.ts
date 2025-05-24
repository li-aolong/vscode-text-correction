import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { ConfigManager } from '../config/configManager';
import { DiffManager, ChangeInfo } from '../diff/diffManager'; // Assuming ChangeInfo is exported from DiffManager

// 新增类型和接口
export type ParagraphIdentifier = string; // 例如 "lineStart-lineEnd"

export enum ParagraphStatus {
    Pending = 'pending',
    Accepted = 'accepted',
    Rejected = 'rejected',
}

export interface ParagraphCorrection {
    id: ParagraphIdentifier;
    originalText: string;
    correctedText: string | null; //  null if no correction or API error
    range: vscode.Range;
    status: ParagraphStatus;
    // 存储对应的 DiffManager ChangeInfo，方便后续操作
    // 注意：ChangeInfo 本身可能不直接存储在这里，而是通过 range 在 DiffManager 中查找
}


interface CorrectionResponse {
    result: boolean;
    corrected_text: string | null;
}

export class CorrectionService {
    // 新增：存储每个段落的纠错信息和状态
    private paragraphCorrections: ParagraphCorrection[] = [];
    // 新增：用于通知 CodeLensProvider 更新
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeParagraphCorrections: vscode.Event<void> = this._onDidChangeParagraphCorrections.event;

    private configManager: ConfigManager;
    private diffManager: DiffManager | undefined;
    private isCancelled = false;
    // 原始文档内容，用于撤销操作
    public originalDocumentContent: string = '';

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
    }

    // 新增：清空所有段落状态和差异
    public clearAllCorrectionsState(): void {
        this.paragraphCorrections = [];
        if (this.diffManager) {
            this.diffManager.clearChanges(); // 清除 DiffManager 中的所有更改和高亮
        }
        this.isCancelled = false;
        this._onDidChangeParagraphCorrections.fire(); // 通知 CodeLens 更新
    }


    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    public updateAllParagraphsStatus(status: ParagraphStatus): void {
        if (status === ParagraphStatus.Accepted || status === ParagraphStatus.Rejected) {
            // After a global accept/reject, all individual paragraph states are effectively finalized
            // and their specific "Pending" status is no longer relevant for CodeLenses.
            // Clearing all corrections will also trigger the onDidChangeParagraphCorrections event.
            this.clearAllCorrectionsState();
        } else {
            // For other statuses (e.g., if we wanted to mark all as Pending again, though not currently used for global actions)
            // We might iterate and update, then fire the event.
            // For now, global actions only lead to Accepted/Rejected, so clearing is appropriate.
            // If a different behavior is needed for other statuses, this part can be expanded.
            this.paragraphCorrections.forEach(p => p.status = status);
            this._onDidChangeParagraphCorrections.fire();
        }
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

        this.clearAllCorrectionsState(); // 开始新的纠错前，清空旧状态

        this.originalDocumentContent = editor.document.getText();
        const paragraphsInfo = this.splitIntoParagraphs(this.originalDocumentContent);

        for (let i = 0; i < paragraphsInfo.length; i++) {
            if (this.isCancelled) {
                vscode.window.showInformationMessage('纠错操作已取消。');
                break;
            }

            if (progressCallback) {
                progressCallback(i + 1, paragraphsInfo.length);
            }

            const paraInfo = paragraphsInfo[i];
            if (paraInfo.content.trim()) {
                try {
                    const apiCorrectedText = await this.correctParagraphAPI(paraInfo.content);
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;
                    const currentRange = new vscode.Range(
                        new vscode.Position(paraInfo.startLine, 0),
                        new vscode.Position(paraInfo.endLine, editor.document.lineAt(paraInfo.endLine).text.length)
                    );

                    if (apiCorrectedText !== paraInfo.content) {
                        // 1. 应用修改到编辑器，以便 DiffManager 可以比较
                        await this.applyCorrectionToEditor(editor, paraInfo, apiCorrectedText);
                        
                        // 2. 创建 ParagraphCorrection 对象
                        const correctionEntry: ParagraphCorrection = {
                            id: paragraphId,
                            originalText: paraInfo.content,
                            correctedText: apiCorrectedText,
                            range: currentRange, // range 可能会因编辑而改变，需要注意
                            status: ParagraphStatus.Pending,
                        };
                        this.paragraphCorrections.push(correctionEntry);

                        // 3. 告诉 DiffManager 添加差异高亮
                        // DiffManager 会根据当前编辑器内容和 originalText 计算差异
                        if (this.diffManager) {
                            this.diffManager.addChange(currentRange, paraInfo.content, apiCorrectedText);
                        }
                    } else {
                         // 即使没有变化，也可能需要记录，以便知道哪些段落被处理过且无错误
                        const noChangeEntry: ParagraphCorrection = {
                            id: paragraphId,
                            originalText: paraInfo.content,
                            correctedText: paraInfo.content, // correctedText is same as original
                            range: currentRange,
                            status: ParagraphStatus.Pending, // Or a new status like 'NoChangeNeeded'
                        };
                        this.paragraphCorrections.push(noChangeEntry);
                    }

                } catch (error) {
                    vscode.window.showErrorMessage(`段落 ${i + 1} 纠错失败: ${error instanceof Error ? error.message : String(error)}`);
                    // 记录失败的段落信息
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;
                    const currentRange = new vscode.Range(
                        new vscode.Position(paraInfo.startLine, 0),
                        new vscode.Position(paraInfo.endLine, editor.document.lineAt(paraInfo.endLine).text.length)
                    );
                    this.paragraphCorrections.push({
                        id: paragraphId,
                        originalText: paraInfo.content,
                        correctedText: null, // API error
                        range: currentRange,
                        status: ParagraphStatus.Pending, // Or a new status like 'ApiError'
                    });
                }
            }
        }
        
        this._onDidChangeParagraphCorrections.fire(); // 所有段落处理完毕，触发 CodeLens 更新

        if (this.diffManager && this.diffManager.hasChanges()) {
            // 考虑是否还需要全局按钮，或者仅依赖段落按钮
            // this.diffManager.showGlobalActionButtons(); 
            vscode.window.showInformationMessage("段落纠错完成，请使用段落旁的按钮进行接受或拒绝操作。");
        } else if (!this.isCancelled) {
            vscode.window.showInformationMessage("文本纠错完成，未发现需要修改的内容。");
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

    private splitIntoParagraphs(text: string): Array<{ content: string, startLine: number, endLine: number }> {
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
                endLine: lines.length - 1 //最后一个段落的结束行号
            });
        }
        
        return paragraphs;
    }

    // 重命名以区分概念上的段落和API调用
    private async correctParagraphAPI(text: string): Promise<string> {
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
                    timeout: config.timeout || 30000 // 使用配置的超时或默认值
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
                return text; // 解析失败则返回原文本
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

    // 修改：此方法仅应用文本到编辑器，不直接与DiffManager交互
    private async applyCorrectionToEditor(
        editor: vscode.TextEditor,
        paragraph: { content: string, startLine: number, endLine: number },
        correctedText: string
    ): Promise<void> {
        const startPos = new vscode.Position(paragraph.startLine, 0);
        const endPos = new vscode.Position(paragraph.endLine, editor.document.lineAt(paragraph.endLine).text.length);
        const range = new vscode.Range(startPos, endPos);

        await editor.edit(editBuilder => {
            editBuilder.replace(range, correctedText);
        });
    }

    // --- 新增段落级操作方法 ---

    public getParagraphCorrectionById(id: ParagraphIdentifier): ParagraphCorrection | undefined {
        return this.paragraphCorrections.find(pc => pc.id === id);
    }
    
    public getParagraphCorrections(): ParagraphCorrection[] {
        return this.paragraphCorrections;
    }

    public getPendingParagraphCorrections(): ParagraphCorrection[] {
        return this.paragraphCorrections.filter(pc => 
            pc.status === ParagraphStatus.Pending && 
            pc.correctedText !== null && // 有纠错结果
            pc.originalText !== pc.correctedText // 且与原文不同
        );
    }

    private findChangeInfoForParagraph(paragraph: ParagraphCorrection): ChangeInfo | undefined {
        if (!this.diffManager) return undefined;
        // DiffManager 的 changes 数组是私有的，我们需要一种方式来获取它
        // 或者 DiffManager 提供一个按 range 查找 ChangeInfo 的方法
        // 假设 DiffManager.getChanges() 存在或我们可以修改它来暴露
        const changes = (this.diffManager as any).changes as ChangeInfo[]; // Type assertion for now
        if (!changes) return undefined;

        return changes.find(change =>
            change.range.isEqual(paragraph.range) &&
            change.original === paragraph.originalText &&
            change.corrected === paragraph.correctedText
        );
    }

    public async acceptParagraph(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphCorrectionById(paragraphId);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending || !this.diffManager) {
            return;
        }

        const changeInfo = this.findChangeInfoForParagraph(paragraph);
        if (changeInfo) {
            // DiffManager.acceptSingleChange 应该会处理编辑器的文本更新和移除 diff
            (this.diffManager as any).acceptSingleChange(changeInfo); // Use 'any' if method is private or not directly accessible
            paragraph.status = ParagraphStatus.Accepted;
            this._onDidChangeParagraphCorrections.fire();
        } else {
            // 如果没有找到 ChangeInfo，可能意味着文本已经被修改或 diff 已被处理
            // 直接将状态标记为接受，并确保文本是纠正后的版本
            if (paragraph.correctedText && paragraph.originalText !== paragraph.correctedText) {
                 await this.applyCorrectionToEditor(editor, {
                    content: paragraph.originalText, // not used by applyCorrectionToEditor for replacement logic
                    startLine: paragraph.range.start.line,
                    endLine: paragraph.range.end.line
                }, paragraph.correctedText);
            }
            paragraph.status = ParagraphStatus.Accepted;
            this._onDidChangeParagraphCorrections.fire();
            console.warn(`Accept: ChangeInfo not found for paragraph ${paragraphId}. Manually updated status.`);
        }
    }

    public async rejectParagraph(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphCorrectionById(paragraphId);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending || !this.diffManager ) {
            return;
        }

        const changeInfo = this.findChangeInfoForParagraph(paragraph);
        if (changeInfo) {
            // DiffManager.rejectSingleChange 应该会处理编辑器的文本恢复和移除 diff
             (this.diffManager as any).rejectSingleChange(changeInfo);
            paragraph.status = ParagraphStatus.Rejected;
            this._onDidChangeParagraphCorrections.fire();
        } else {
            // 如果没有找到 ChangeInfo，恢复原始文本
            await editor.edit(editBuilder => {
                editBuilder.replace(paragraph.range, paragraph.originalText);
            });
            paragraph.status = ParagraphStatus.Rejected;
            this._onDidChangeParagraphCorrections.fire();
            console.warn(`Reject: ChangeInfo not found for paragraph ${paragraphId}. Manually reverted and updated status.`);
        }
    }
}

import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { ConfigManager } from '../config/configManager';
import { DiffManager, ChangeInfo } from '../diff/diffManager'; // Assuming ChangeInfo is exported from DiffManager
import { EditorStateManager } from './editorStateManager';

// 新增类型和接口
export type ParagraphIdentifier = string; // 例如 "lineStart-lineEnd"

export enum ParagraphStatus {
    Pending = 'pending',
    Accepted = 'accepted',
    Rejected = 'rejected',
    Error = 'error',
}

export interface ParagraphCorrection {
    id: ParagraphIdentifier;
    originalText: string; // 不包含换行符的纯文本，用于API调用
    correctedText: string | null; //  null if no correction or API error
    range: vscode.Range;
    status: ParagraphStatus;
    originalLines: string[]; // 保存原始行结构，用于拒绝时恢复
    errorMessage?: string; // 错误信息，当status为Error时使用
    // 存储对应的 DiffManager ChangeInfo，方便后续操作
    // 注意：ChangeInfo 本身可能不直接存储在这里，而是通过 range 在 DiffManager 中查找
}


interface CorrectionResponse {
    result: boolean;
    corrected_text: string | null;
}

interface ApiUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

interface ApiResponse {
    choices: Array<{
        message: {
            content: string;
        };
    }>;
    usage?: ApiUsage;
}

export class CorrectionService {
    // 新增：用于通知 CodeLensProvider 更新
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeParagraphCorrections: vscode.Event<void> = this._onDidChangeParagraphCorrections.event;

    private configManager: ConfigManager;
    private editorStateManager: EditorStateManager;
    private diffManager: DiffManager | undefined;

    // 操作锁：防止并发操作导致的状态混乱
    private operationLocks: Map<string, boolean> = new Map();

    constructor(configManager: ConfigManager, editorStateManager: EditorStateManager) {
        this.configManager = configManager;
        this.editorStateManager = editorStateManager;
    }

    // 新增：清空指定编辑器的段落状态和差异
    public clearAllCorrectionsState(editor: vscode.TextEditor): void {
        this.editorStateManager.clearEditorCorrectionState(editor);
        if (this.diffManager) {
            this.diffManager.clearChanges(); // 清除 DiffManager 中的所有更改和高亮
        }
        // isCancelled 现在由 EditorStateManager 管理
        this._onDidChangeParagraphCorrections.fire(); // 通知 CodeLens 更新
    }


    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    /**
     * 获取操作锁的键
     */
    private getOperationLockKey(editor: vscode.TextEditor, operation: string, paragraphId?: string): string {
        const editorUri = editor.document.uri.toString();
        return paragraphId ? `${editorUri}:${operation}:${paragraphId}` : `${editorUri}:${operation}`;
    }

    /**
     * 尝试获取操作锁
     */
    private tryAcquireOperationLock(lockKey: string): boolean {
        if (this.operationLocks.get(lockKey)) {
            return false; // 锁已被占用
        }
        this.operationLocks.set(lockKey, true);
        return true;
    }

    /**
     * 释放操作锁
     */
    private releaseOperationLock(lockKey: string): void {
        this.operationLocks.delete(lockKey);
    }

    public updateAllParagraphsStatus(status: ParagraphStatus): void {
        // 这个方法需要重构，因为现在状态是按编辑器管理的
        // 暂时保留原有逻辑，但需要传入editor参数
        this._onDidChangeParagraphCorrections.fire();
    }

    /**
     * 只更新仍处于Pending状态的段落，保留已经被用户操作过的段落状态
     */
    public updatePendingParagraphsStatus(status: ParagraphStatus, editor: vscode.TextEditor): void {
        console.log(`UPDATE_PENDING_PARAGRAPHS_STATUS: ${status}`);

        const corrections = this.editorStateManager.getParagraphCorrections(editor);
        let updatedCount = 0;
        corrections.forEach(p => {
            if (p.status === ParagraphStatus.Pending) {
                console.log(`  UPDATING paragraph ${p.id}: Pending -> ${status}`);
                p.status = status;
                updatedCount++;
            } else {
                console.log(`  KEEPING paragraph ${p.id}: ${p.status} (already processed)`);
            }
        });

        console.log(`UPDATED_${updatedCount}_PARAGRAPHS, KEPT_${corrections.length - updatedCount}_EXISTING`);
        this._onDidChangeParagraphCorrections.fire();
    }

    /**
     * 智能全部接受：只接受仍处于Pending状态的段落
     */
    public async acceptAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        // 尝试获取全局操作锁
        const lockKey = this.getOperationLockKey(editor, 'acceptAll');
        if (!this.tryAcquireOperationLock(lockKey)) {
            console.warn(`[AcceptAll] 编辑器正在处理其他操作，跳过全部接受`);
            vscode.window.showWarningMessage('正在处理其他操作，请稍后再试');
            return;
        }

        let pendingCount = 0;
        try {
            const corrections = this.editorStateManager.getParagraphCorrections(editor);
            const pendingParagraphs = corrections.filter(p => p.status === ParagraphStatus.Pending);
            pendingCount = pendingParagraphs.length;

            for (const paragraph of pendingParagraphs) {
                await this.acceptParagraph(paragraph.id, editor);
            }

            // 强制清理所有装饰和状态
            if (this.diffManager) {
                // 清理装饰
                this.diffManager.clearDecorationsForEditor(editor);
                // 清理changes
                this.editorStateManager.setChanges(editor, []);
            }

            // 自动保存文件
            await this.saveFile(editor);

            // 触发状态更新
            this._onDidChangeParagraphCorrections.fire();

            // 触发状态栏更新
            this.triggerStatusBarUpdate();

            // 显示操作完成消息
            const fileName = editor.document.uri.toString().split('/').pop() || '文档';
            vscode.window.showInformationMessage(`已接受所有 ${pendingCount} 处修改并保存文件 "${fileName}"`);
        } finally {
            this.releaseOperationLock(lockKey);
        }
    }

    /**
     * 基于撤销操作的全部拒绝：恢复到纠错前的原始状态
     */
    public async rejectAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        // 尝试获取全局操作锁
        const lockKey = this.getOperationLockKey(editor, 'rejectAll');
        if (!this.tryAcquireOperationLock(lockKey)) {
            console.warn(`[RejectAll] 编辑器正在处理其他操作，跳过全部拒绝`);
            vscode.window.showWarningMessage('正在处理其他操作，请稍后再试');
            return;
        }

        try {
            const state = this.editorStateManager.getEditorState(editor);

            // 检查是否有原始文档内容
            if (!state.originalDocumentContent) {
                vscode.window.showWarningMessage('无法拒绝修改：未找到原始文档内容');
                return;
            }

            console.log('[RejectAll] 开始基于撤销的全部拒绝操作');

            // 直接恢复整个文档到原始状态
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length)
            );

            // 使用WorkspaceEdit恢复原始内容
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.replace(editor.document.uri, fullRange, state.originalDocumentContent);

            const success = await vscode.workspace.applyEdit(workspaceEdit);

            if (!success) {
                // 回退到直接编辑器操作
                console.warn('[RejectAll] WorkspaceEdit失败，使用直接编辑器操作');
                const editorSuccess = await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, state.originalDocumentContent);
                });

                if (!editorSuccess) {
                    throw new Error('无法恢复原始文档内容');
                }
            }

            console.log('[RejectAll] 文档内容已恢复到原始状态');

            // 清理所有相关状态
            this.cleanupAfterRejectAll(editor);

            // 保存文件
            await editor.document.save();
            vscode.window.showInformationMessage('已拒绝所有修改并恢复到原始状态');

        } catch (error) {
            console.error('[RejectAll] 操作失败:', error);
            vscode.window.showErrorMessage(`拒绝修改失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.releaseOperationLock(lockKey);
        }
    }

    /**
     * 清理拒绝全部操作后的状态
     */
    private cleanupAfterRejectAll(editor: vscode.TextEditor): void {
        // 清理段落纠错状态
        this.editorStateManager.setParagraphCorrections(editor, []);

        // 清理diff管理器状态
        if (this.diffManager) {
            this.diffManager.clearDecorationsForEditor(editor);
            this.editorStateManager.setChanges(editor, []);
        }

        // 重置编辑器状态
        this.editorStateManager.updateEditorState(editor, {
            isCorrectingInProgress: false,
            originalDocumentContent: '',
            currentChangeIndex: 0
        });

        // 触发状态栏更新
        this.triggerStatusBarUpdate();
    }

    public async correctFullText(
        editor: vscode.TextEditor,
        progressCallback?: (current: number, total: number) => void
    ): Promise<void> {
        const errors = this.configManager.validateConfig();

        if (errors.length > 0) {
            throw new Error(`配置错误: ${errors.join(', ')}`);
        }

        // 保存编辑器URI用于后续操作
        const editorUri = editor.document.uri.toString();
        console.log(`Starting text correction...`);

        this.clearAllCorrectionsState(editor); // 开始新的纠错前，清空旧状态

        // 保存原始文档内容到编辑器状态中
        this.editorStateManager.updateEditorState(editor, {
            originalDocumentContent: editor.document.getText(),
            isCorrectingInProgress: true
        });

        const editorState = this.editorStateManager.getEditorState(editor);
        const paragraphsInfo = this.splitIntoParagraphs(editorState.originalDocumentContent);

        // 立即显示初始进度和状态
        if (progressCallback) {
            progressCallback(0, paragraphsInfo.length);
        }

        // 使用更简单可靠的方法：逐个处理段落，每次都重新获取当前文档状态
        for (let i = 0; i < paragraphsInfo.length; i++) {
            // 检查是否被取消
            const currentState = this.editorStateManager.getEditorState(editor);
            if (currentState.isCancelled) {
                vscode.window.showInformationMessage('纠错操作已取消。');
                break;
            }

            // 始终使用原始编辑器进行纠错，不受页面切换影响
            let currentEditor = editor;
            let isBackgroundCorrection = false;

            // 检查原始编辑器是否仍然有效
            if (!this.editorStateManager.isEditorValid(editor)) {
                console.error(`Original editor is no longer valid for URI: ${editorUri}`);
                // 保存当前状态
                const editorState = this.editorStateManager.getEditorState(editor);
                editorState.isCorrectingInProgress = false;
                throw new Error('编辑器已关闭或不可用');
            }

            // 检查当前编辑器是否可见，如果不可见则为后台纠错
            const isVisible = vscode.window.visibleTextEditors.some(e =>
                e.document.uri.toString() === editorUri
            );

            if (!isVisible) {
                isBackgroundCorrection = true;
                console.log('Performing background correction - editor not visible');
            }

            // 如果是后台纠错且是第一次检测到，显示提示
            if (isBackgroundCorrection && i === 0) {
                const fileName = editorUri.split('/').pop() || '文档';
                vscode.window.showInformationMessage(`${fileName} 正在后台进行纠错，您可以继续其他工作`);
            }

            if (progressCallback) {
                progressCallback(i + 1, paragraphsInfo.length);
            }

            const paraInfo = paragraphsInfo[i];
            if (paraInfo.content.trim()) {
                try {
                    const apiResult = await this.correctParagraphAPI(paraInfo.content);

                    // 计算并累计花费
                    if (apiResult.usage) {
                        this.calculateAndUpdateCost(currentEditor, apiResult.usage);
                    }

                    // 重新获取当前段落在文档中的实际位置
                    const currentRange = this.findParagraphInCurrentDocument(currentEditor, paraInfo.content, i);
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;

                    // 获取当前实际的行结构（基于找到的位置）
                    const originalLines = [];
                    for (let lineIndex = currentRange.start.line; lineIndex <= currentRange.end.line; lineIndex++) {
                        originalLines.push(currentEditor.document.lineAt(lineIndex).text);
                    }



                    if (apiResult.correctedText !== paraInfo.content) {
                        // 1. 应用修改到编辑器
                        await this.applyCorrectionToEditor(currentEditor, {
                            content: paraInfo.content,
                            startLine: currentRange.start.line,
                            endLine: currentRange.end.line
                        }, apiResult.correctedText);

                        // 2. 重新计算修改后的range（基于新的文档状态）
                        const newRange = this.calculateRangeAfterReplacement(currentRange, apiResult.correctedText);

                        // 3. 创建 ParagraphCorrection 对象
                        const correctionEntry: ParagraphCorrection = {
                            id: paragraphId,
                            originalText: paraInfo.content,
                            correctedText: apiResult.correctedText,
                            range: newRange,
                            status: ParagraphStatus.Pending,
                            originalLines: originalLines,
                        };
                        this.editorStateManager.addParagraphCorrection(currentEditor, correctionEntry);

                        // 4. 告诉 DiffManager 添加差异高亮到正确的编辑器
                        if (this.diffManager) {
                            this.diffManager.addChange(newRange, paraInfo.content, apiResult.correctedText, currentEditor);

                            // 立即强制更新装饰，确保diff显示
                            setTimeout(() => {
                                this.diffManager?.updateDecorationsForEditor(currentEditor);
                            }, 50);
                        }

                        // 5. 立即更新后续段落的range（因为当前段落的行数可能发生了变化）
                        this.updateSubsequentParagraphRanges(correctionEntry, currentEditor);
                    }

                } catch (error) {
                    // 记录失败的段落信息
                    const currentRange = this.findParagraphInCurrentDocument(currentEditor, paraInfo.content, i);
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;

                    // 获取原始行结构（即使API失败也需要保存）
                    const originalLines = [];
                    for (let lineIndex = currentRange.start.line; lineIndex <= currentRange.end.line; lineIndex++) {
                        originalLines.push(currentEditor.document.lineAt(lineIndex).text);
                    }

                    this.editorStateManager.addParagraphCorrection(currentEditor, {
                        id: paragraphId,
                        originalText: paraInfo.content,
                        correctedText: null, // API error
                        range: currentRange,
                        status: ParagraphStatus.Error, // 使用错误状态
                        originalLines: originalLines,
                        errorMessage: "纠错失败" // 简化错误信息
                    });
                }
            }
        }

        // 标记纠错完成
        const finalEditor = this.editorStateManager.getValidEditor(editorUri);
        if (finalEditor) {
            this.editorStateManager.updateEditorState(finalEditor, {
                isCorrectingInProgress: false
            });
        }

        this._onDidChangeParagraphCorrections.fire(); // 所有段落处理完毕，触发 CodeLens 更新

        // 强制更新装饰，确保所有diff都正确显示
        if (this.diffManager && finalEditor) {
            setTimeout(() => {
                this.diffManager?.updateDecorationsForEditor(finalEditor);
            }, 100);
        }

        if (this.diffManager && this.diffManager.hasChanges()) {
            // 考虑是否还需要全局按钮，或者仅依赖段落按钮
            // this.diffManager.showGlobalActionButtons();
            vscode.window.showInformationMessage(`文档 "${editorUri.split('/').pop()}" 纠错完成，请使用段落旁的按钮进行接受或拒绝操作。`);
        } else {
            // 检查是否被取消
            const finalState = this.editorStateManager.getEditorState(editor);
            if (!finalState.isCancelled) {
                vscode.window.showInformationMessage(`文档 "${editorUri.split('/').pop()}" 纠错完成，未发现需要修改的内容。`);
            }
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
        // 这个方法现在主要由 extension.ts 中的取消命令处理
        // 保留此方法以保持向后兼容性
    }

    /**
     * 恢复暂停的纠错过程
     */
    public async resumeCorrection(editor: vscode.TextEditor): Promise<void> {
        const state = this.editorStateManager.getEditorState(editor);
        if (state.isCorrectingInProgress) {
            console.log('Resuming correction for editor:', editor.document.uri.toString());
            // 重新开始纠错过程
            await this.correctFullText(editor);
        }
    }

    /**
     * 保存文件
     */
    private async saveFile(editor: vscode.TextEditor): Promise<void> {
        try {
            await editor.document.save();
        } catch (error) {
            console.error('Failed to save file:', error);
            vscode.window.showErrorMessage(`保存文件失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 计算并更新花费信息
     */
    private calculateAndUpdateCost(editor: vscode.TextEditor, usage: ApiUsage): void {
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

        // 立即触发状态栏更新，显示当前已花费金额
        this.triggerStatusBarUpdate();
    }

    /**
     * 触发状态栏更新
     */
    private triggerStatusBarUpdate(): void {
        // 触发状态变化事件，让extension.ts更新状态栏
        this._onDidChangeParagraphCorrections.fire();

        // 延迟触发，确保状态变化被处理
        setTimeout(() => {
            this._onDidChangeParagraphCorrections.fire();
        }, 100);
    }

    private splitIntoParagraphs(text: string): Array<{ content: string, startLine: number, endLine: number }> {
        // 标准化换行符：将\r\n和\r都转换为\n
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalizedText.split('\n');
        const paragraphs: Array<{content: string, startLine: number, endLine: number}> = [];

        let currentParagraph = '';
        let startLine = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim() === '') {
                if (currentParagraph.trim()) {
                    paragraphs.push({
                        content: currentParagraph, // 保留段落内的换行符
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
                // 保留段落内的换行符，不用空格替换
                currentParagraph += (currentParagraph ? '\n' : '') + line;
            }
        }

        // 处理最后一个段落
        if (currentParagraph.trim()) {
            paragraphs.push({
                content: currentParagraph, // 保留段落内的换行符
                startLine: startLine,
                endLine: lines.length - 1
            });
        }

        // 简化日志输出

        return paragraphs;
    }

    // 重命名以区分概念上的段落和API调用
    private async correctParagraphAPI(text: string): Promise<{ correctedText: string; usage?: ApiUsage }> {
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
                    timeout: config.timeout || 30000 // 使用配置的超时或默认值
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
        // 验证编辑器是否仍然有效
        if (!this.editorStateManager.isEditorValid(editor)) {
            throw new Error('Editor is no longer valid');
        }

        const document = editor.document;
        const startPos = new vscode.Position(paragraph.startLine, 0);

        // 计算段落结束位置：如果不是最后一行，包含行尾换行符
        let endPos: vscode.Position;
        if (paragraph.endLine < document.lineCount - 1) {
            // 不是最后一行，包含换行符
            endPos = new vscode.Position(paragraph.endLine + 1, 0);
        } else {
            // 是最后一行，到行末
            endPos = new vscode.Position(paragraph.endLine, document.lineAt(paragraph.endLine).text.length);
        }

        const range = new vscode.Range(startPos, endPos);

        // 直接使用纠正后的文本，因为现在保留了段落内的换行符
        // 如果不是最后一行，确保保留换行符
        const finalText = (paragraph.endLine < document.lineCount - 1) ?
            correctedText + '\n' : correctedText;

        try {
            // 使用WorkspaceEdit进行更可靠的编辑，即使编辑器不可见也能工作
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.replace(document.uri, range, finalText);

            const success = await vscode.workspace.applyEdit(workspaceEdit);

            if (!success) {
                // 如果WorkspaceEdit失败，回退到直接编辑器操作
                console.warn('WorkspaceEdit failed, falling back to direct editor edit');
                const editorSuccess = await editor.edit(editBuilder => {
                    editBuilder.replace(range, finalText);
                });

                if (!editorSuccess) {
                    throw new Error('Both WorkspaceEdit and direct editor edit failed');
                }
            }
        } catch (error) {
            console.error('Error in applyCorrectionToEditor:', error);
            throw new Error(`TextEditor edit failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 在当前文档中查找段落的实际位置
     * 使用更可靠的方法来处理段落位置变化
     */
    private findParagraphInCurrentDocument(
        editor: vscode.TextEditor,
        targetContent: string,
        paragraphIndex: number
    ): vscode.Range {
        const document = editor.document;
        // 标准化文档内容的换行符
        const normalizedDocText = document.getText().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalizedDocText.split('\n');
        // 标准化目标内容的换行符
        const normalizedTargetContent = targetContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const targetLines = normalizedTargetContent.split('\n');

        // 如果是第一个段落，从文档开头开始查找
        let searchStartLine = 0;

        // 从搜索起始位置开始查找匹配的段落
        for (let startLine = searchStartLine; startLine < lines.length; startLine++) {
            // 跳过空行
            if (lines[startLine].trim() === '') continue;

            // 检查是否匹配第一行
            if (lines[startLine] === targetLines[0]) {
                // 检查是否完全匹配整个段落
                let matches = true;
                let endLine = startLine;

                for (let i = 0; i < targetLines.length && startLine + i < lines.length; i++) {
                    if (lines[startLine + i] !== targetLines[i]) {
                        matches = false;
                        break;
                    }
                    endLine = startLine + i;
                }

                if (matches) {
                    return new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(endLine, lines[endLine].length)
                    );
                }
            }
        }

        // 如果找不到匹配的内容，使用启发式方法
        console.warn(`Could not find exact match for paragraph ${paragraphIndex}, using heuristic approach`);

        // 尝试找到包含第一行内容的位置
        const firstLine = targetLines[0];
        for (let startLine = searchStartLine; startLine < lines.length; startLine++) {
            if (lines[startLine].includes(firstLine) || firstLine.includes(lines[startLine])) {
                const endLine = Math.min(startLine + targetLines.length - 1, lines.length - 1);
                console.log(`  HEURISTIC_MATCH: L${startLine + 1}-L${endLine + 1}`);
                return new vscode.Range(
                    new vscode.Position(startLine, 0),
                    new vscode.Position(endLine, lines[endLine].length)
                );
            }
        }

        // 最后的回退方案：使用原始位置
        const fallbackStartLine = Math.min(searchStartLine, lines.length - 1);
        const fallbackEndLine = Math.min(fallbackStartLine + targetLines.length - 1, lines.length - 1);

        console.log(`  FALLBACK_RANGE: L${fallbackStartLine + 1}-L${fallbackEndLine + 1}`);
        return new vscode.Range(
            new vscode.Position(fallbackStartLine, 0),
            new vscode.Position(fallbackEndLine, lines[fallbackEndLine].length)
        );
    }

    /**
     * 计算替换文本后的新range
     */
    private calculateRangeAfterReplacement(
        originalRange: vscode.Range,
        newText: string
    ): vscode.Range {
        const newLines = newText.split('\n');
        const startPos = originalRange.start;

        // 计算新的结束位置
        const newEndLine = startPos.line + newLines.length - 1;
        const newEndChar = newLines.length > 0 ? newLines[newLines.length - 1].length : 0;

        // 简化日志输出

        return new vscode.Range(
            startPos,
            new vscode.Position(newEndLine, newEndChar)
        );
    }

    /**
     * 更新后续段落的range，当某个段落被修改后调用
     */
    private updateSubsequentParagraphRanges(changedParagraph: ParagraphCorrection, editor: vscode.TextEditor): void {
        // TODO: 需要重构这个方法来使用EditorStateManager
        // 重新计算所有段落的位置，使用更智能的方法
        this.recalculateAllParagraphRanges(editor);
    }

    /**
     * 重新计算所有段落的range位置
     * 这个方法会重新扫描整个文档来定位每个段落
     */
    private recalculateAllParagraphRanges(editor: vscode.TextEditor): void {
        const document = editor.document;
        const normalizedDocText = document.getText().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const docLines = normalizedDocText.split('\n');

        // 为每个段落重新查找位置
        let currentSearchLine = 0;
        const corrections = this.editorStateManager.getParagraphCorrections(editor);

        for (let i = 0; i < corrections.length; i++) {
            const paragraph = corrections[i];

            // 跳过已拒绝的段落，它们不需要重新计算范围
            if (paragraph.status === ParagraphStatus.Rejected) {
                continue;
            }

            // 对于未拒绝的段落，我们需要在文档中查找纠正后的文本
            const targetText = paragraph.correctedText || paragraph.originalText;
            const normalizedTargetText = targetText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const targetLines = normalizedTargetText.split('\n');

            // 从当前搜索位置开始查找纠正后的文本
            let found = false;
            for (let startLine = currentSearchLine; startLine < docLines.length; startLine++) {
                // 跳过空行
                if (docLines[startLine].trim() === '') continue;

                // 检查是否匹配第一行
                if (docLines[startLine] === targetLines[0]) {
                    // 检查是否完全匹配整个段落
                    let matches = true;
                    let endLine = startLine;

                    for (let j = 0; j < targetLines.length && startLine + j < docLines.length; j++) {
                        if (docLines[startLine + j] !== targetLines[j]) {
                            matches = false;
                            break;
                        }
                        endLine = startLine + j;
                    }

                    if (matches) {
                        // 更精确地计算范围，考虑实际的文本内容
                        const newRange = this.calculatePreciseRange(document, startLine, endLine, targetLines);

                        paragraph.range = newRange;
                        currentSearchLine = endLine + 1; // 下次从这个段落后面开始搜索
                        found = true;

                        // 同时更新DiffManager中对应的ChangeInfo
                        if (this.diffManager) {
                            const changes = this.editorStateManager.getChanges(editor);
                            const changeInfo = changes.find(change =>
                                change.original === paragraph.originalText &&
                                change.corrected === paragraph.correctedText
                            );
                            if (changeInfo) {
                                changeInfo.range = newRange;
                            }
                        }
                        break;
                    }
                }
            }

            if (!found) {
                console.warn(`    PARAGRAPH_${i}_CORRECTED_TEXT_NOT_FOUND, keeping old range`);
            }
        }

        // 简化日志输出
    }

    /**
     * 精确计算段落范围，包括正确的字符位置
     */
    private calculatePreciseRange(
        document: vscode.TextDocument,
        startLine: number,
        endLine: number,
        targetLines: string[]
    ): vscode.Range {
        // 对于单行段落，计算精确的字符范围
        if (targetLines.length === 1) {
            const lineText = document.lineAt(startLine).text;
            const targetText = targetLines[0];

            // 在行内查找目标文本的精确位置
            const startChar = lineText.indexOf(targetText);
            if (startChar !== -1) {
                const endChar = startChar + targetText.length;
                return new vscode.Range(
                    new vscode.Position(startLine, startChar),
                    new vscode.Position(startLine, endChar)
                );
            }
        }

        // 对于多行段落，使用更精确的计算
        let actualStartLine = startLine;
        let actualEndLine = endLine;
        let startChar = 0;
        let endChar = 0;

        // 查找第一行的精确开始位置
        const firstLineText = document.lineAt(actualStartLine).text;
        const firstTargetLine = targetLines[0];
        const firstLineStart = firstLineText.indexOf(firstTargetLine);
        if (firstLineStart !== -1) {
            startChar = firstLineStart;
        }

        // 查找最后一行的精确结束位置
        const lastLineText = document.lineAt(actualEndLine).text;
        const lastTargetLine = targetLines[targetLines.length - 1];
        const lastLineStart = lastLineText.indexOf(lastTargetLine);
        if (lastLineStart !== -1) {
            endChar = lastLineStart + lastTargetLine.length;
        } else {
            endChar = lastLineText.length;
        }

        // 简化日志输出

        return new vscode.Range(
            new vscode.Position(actualStartLine, startChar),
            new vscode.Position(actualEndLine, endChar)
        );
    }

    // --- 新增段落级操作方法 ---

    public getParagraphCorrectionById(id: ParagraphIdentifier, editor: vscode.TextEditor): ParagraphCorrection | undefined {
        const corrections = this.editorStateManager.getParagraphCorrections(editor);
        return corrections.find(pc => pc.id === id);
    }

    public getParagraphCorrections(editor: vscode.TextEditor): ParagraphCorrection[] {
        return this.editorStateManager.getParagraphCorrections(editor);
    }

    public getPendingParagraphCorrections(editor: vscode.TextEditor): ParagraphCorrection[] {
        const corrections = this.editorStateManager.getParagraphCorrections(editor);
        return corrections.filter(pc =>
            pc.status === ParagraphStatus.Pending &&
            pc.correctedText !== null && // 有纠错结果
            pc.originalText !== pc.correctedText // 且与原文不同
        );
    }

    private findChangeInfoForParagraph(paragraph: ParagraphCorrection): ChangeInfo | undefined {
        if (!this.diffManager) return undefined;

        // 需要找到包含这个段落的编辑器
        let targetEditor: vscode.TextEditor | undefined;

        // 遍历所有可见编辑器，找到包含这个段落的编辑器
        for (const editor of vscode.window.visibleTextEditors) {
            const corrections = this.editorStateManager.getParagraphCorrections(editor);
            if (corrections.includes(paragraph)) {
                targetEditor = editor;
                break;
            }
        }

        if (!targetEditor) {
            targetEditor = this.editorStateManager.getValidEditor();
        }

        if (!targetEditor) return undefined;

        const changes = this.editorStateManager.getChanges(targetEditor);

        return changes.find(change =>
            change.range.isEqual(paragraph.range) &&
            change.original === paragraph.originalText &&
            change.corrected === paragraph.correctedText
        );
    }

    public async acceptParagraph(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphCorrectionById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending || !this.diffManager) {
            return;
        }

        // 尝试获取操作锁
        const lockKey = this.getOperationLockKey(editor, 'accept', paragraphId);
        if (!this.tryAcquireOperationLock(lockKey)) {
            console.warn(`[AcceptParagraph] 段落 ${paragraphId} 正在处理中，跳过重复操作`);
            return;
        }

        try {
            console.log(`[AcceptParagraph] 开始接受段落: ${paragraphId}`);

            // 再次检查段落状态（防止在等待锁期间状态发生变化）
            if (paragraph.status !== ParagraphStatus.Pending) {
                console.warn(`[AcceptParagraph] 段落 ${paragraphId} 状态已变化为 ${paragraph.status}，取消操作`);
                return;
            }

            const changeInfo = this.findChangeInfoForParagraph(paragraph);
            if (changeInfo) {
                // DiffManager.acceptSingleChange 应该会处理编辑器的文本更新和移除 diff
                await (this.diffManager as any).acceptSingleChange(changeInfo); // Use 'any' if method is private or not directly accessible
                paragraph.status = ParagraphStatus.Accepted;

                // 立即触发CodeLens更新，确保按钮立即消失
                this._onDidChangeParagraphCorrections.fire();

                // 强制刷新CodeLens
                setTimeout(() => {
                    vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
                }, 10);

                // 触发状态栏更新
                this.triggerStatusBarUpdate();

                // 强制更新装饰，确保被接受的段落装饰被清除
                if (this.diffManager) {
                    this.diffManager.updateDecorationsForEditor(editor);
                }

                // 打印接受后的编辑器状态
                this.printEditorContent(editor, `AFTER_ACCEPT_${paragraphId}`);
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

                // 打印接受后的编辑器状态
                this.printEditorContent(editor, `AFTER_ACCEPT_${paragraphId}`);
            }
        } catch (error) {
            console.error(`[AcceptParagraph] 接受段落失败:`, error);
            vscode.window.showErrorMessage(`接受段落失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // 确保释放操作锁
            this.releaseOperationLock(lockKey);
        }
    }

    /**
     * 关闭错误提示
     */
    public async dismissError(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphCorrectionById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Error) {
            return;
        }

        // 从段落纠正列表中移除错误段落
        const corrections = this.editorStateManager.getParagraphCorrections(editor);
        const index = corrections.indexOf(paragraph);
        if (index > -1) {
            corrections.splice(index, 1);
            this.editorStateManager.setParagraphCorrections(editor, corrections);
        }

        this._onDidChangeParagraphCorrections.fire();
        this.triggerStatusBarUpdate();
    }

    public async rejectParagraph(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphCorrectionById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending) {
            return;
        }

        // 尝试获取操作锁
        const lockKey = this.getOperationLockKey(editor, 'reject', paragraphId);
        if (!this.tryAcquireOperationLock(lockKey)) {
            console.warn(`[RejectParagraph] 段落 ${paragraphId} 正在处理中，跳过重复操作`);
            return;
        }

        try {
            console.log(`[RejectParagraph] 开始拒绝段落: ${paragraphId}`);

            // 再次检查段落状态（防止在等待锁期间状态发生变化）
            if (paragraph.status !== ParagraphStatus.Pending) {
                console.warn(`[RejectParagraph] 段落 ${paragraphId} 状态已变化为 ${paragraph.status}，取消操作`);
                return;
            }

            // 使用撤销逻辑来拒绝段落（类似全部拒绝的逻辑）
            await this.rejectParagraphByUndo(paragraph, editor);

        } catch (error) {
            console.error(`[RejectParagraph] 拒绝段落失败:`, error);
            vscode.window.showErrorMessage(`拒绝段落失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // 确保释放操作锁
            this.releaseOperationLock(lockKey);
        }
    }

    /**
     * 使用撤销逻辑拒绝段落（类似全部拒绝的逻辑）
     */
    private async rejectParagraphByUndo(paragraph: ParagraphCorrection, editor: vscode.TextEditor): Promise<void> {
        try {
            console.log(`[RejectByUndo] 使用撤销逻辑拒绝段落: ${paragraph.id}`);

            // 查找对应的ChangeInfo
            const changeInfo = this.findChangeInfoForParagraph(paragraph);
            if (!changeInfo) {
                console.warn(`[RejectByUndo] 未找到对应的ChangeInfo，尝试通过文档内容查找`);

                // 尝试在当前文档中查找纠正后的文本
                const document = editor.document;
                const currentText = document.getText();
                const correctedText = paragraph.correctedText || '';

                if (correctedText && currentText.includes(correctedText)) {
                    // 找到纠正后的文本，尝试替换为原始文本
                    const newText = currentText.replace(correctedText, paragraph.originalText);

                    const workspaceEdit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
                    );
                    workspaceEdit.replace(document.uri, fullRange, newText);

                    const success = await vscode.workspace.applyEdit(workspaceEdit);
                    if (success) {
                        paragraph.status = ParagraphStatus.Rejected;
                        this.cleanupParagraphFromDiffManager(paragraph, editor);

                        // 检查是否有行数变化，如果有则需要重新计算所有段落位置
                        const originalLineCount = paragraph.originalText.split('\n').length;
                        const correctedLineCount = (paragraph.correctedText || '').split('\n').length;
                        const hasLineCountChange = originalLineCount !== correctedLineCount;

                        if (hasLineCountChange) {
                            console.log(`[RejectByUndo] 备用方法检测到行数变化，重新计算所有段落位置`);
                            await this.recalculateAllParagraphsAfterRejectSafe(editor, paragraph);
                        }

                        this._onDidChangeParagraphCorrections.fire();

                        // 强制刷新CodeLens
                        setTimeout(() => {
                            vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
                        }, 10);

                        this.triggerStatusBarUpdate();
                        console.log(`[RejectByUndo] 通过文档内容查找成功拒绝段落: ${paragraph.id}`);
                        return;
                    }
                }

                // 如果都失败了，直接清理状态
                paragraph.status = ParagraphStatus.Rejected;
                this.cleanupParagraphFromDiffManager(paragraph, editor);
                this._onDidChangeParagraphCorrections.fire();

                // 强制刷新CodeLens
                setTimeout(() => {
                    vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
                }, 10);

                this.triggerStatusBarUpdate();
                console.warn(`[RejectByUndo] 无法恢复文本，仅清理状态: ${paragraph.id}`);
                return;
            }

            // 使用类似全部拒绝的逻辑：直接替换range内容为原始文本
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.replace(editor.document.uri, changeInfo.range, changeInfo.original);

            const success = await vscode.workspace.applyEdit(workspaceEdit);

            if (!success) {
                // 如果WorkspaceEdit失败，回退到直接编辑器操作
                console.warn('[RejectByUndo] WorkspaceEdit失败，使用直接编辑器操作');
                const editorSuccess = await editor.edit(editBuilder => {
                    editBuilder.replace(changeInfo.range, changeInfo.original);
                });

                if (!editorSuccess) {
                    throw new Error('撤销操作失败');
                }
            }

            // 更新段落状态
            paragraph.status = ParagraphStatus.Rejected;

            // 清理diff状态
            this.cleanupParagraphFromDiffManager(paragraph, editor);

            // 检查是否有行数变化，如果有则需要重新计算所有段落位置
            const originalLineCount = paragraph.originalText.split('\n').length;
            const correctedLineCount = (paragraph.correctedText || '').split('\n').length;
            const hasLineCountChange = originalLineCount !== correctedLineCount;

            if (hasLineCountChange) {
                console.log(`[RejectByUndo] 检测到行数变化 (原始:${originalLineCount}, 纠正:${correctedLineCount})，重新计算所有段落位置`);
                // 重新计算所有段落的位置并重建DiffManager状态
                await this.recalculateAllParagraphsAfterRejectSafe(editor, paragraph);
            }

            // 立即触发CodeLens更新，确保按钮立即消失
            this._onDidChangeParagraphCorrections.fire();

            // 强制刷新CodeLens
            setTimeout(() => {
                vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
            }, 10);

            this.triggerStatusBarUpdate();

            console.log(`[RejectByUndo] 段落撤销成功: ${paragraph.id}`);

        } catch (error) {
            console.error(`[RejectByUndo] 撤销拒绝失败:`, error);
            throw error;
        }
    }

    /**
     * 备用段落拒绝方法：当DiffManager拒绝失败时使用
     */
    private async fallbackRejectParagraph(paragraph: ParagraphCorrection, editor: vscode.TextEditor): Promise<void> {
        try {
            console.log(`[FallbackReject] 使用备用方法拒绝段落: ${paragraph.id}`);

            // 方法1：尝试使用原始行结构恢复
            if (paragraph.originalLines && paragraph.originalLines.length > 0) {
                const originalText = paragraph.originalLines.join('\n');
                const document = editor.document;
                const currentText = document.getText();

                // 查找纠正后的文本
                const correctedText = paragraph.correctedText || '';
                const correctedIndex = currentText.indexOf(correctedText);

                if (correctedIndex !== -1) {
                    // 计算替换后的新文本
                    const newText = currentText.substring(0, correctedIndex) +
                                   originalText +
                                   currentText.substring(correctedIndex + correctedText.length);

                    // 使用WorkspaceEdit进行替换
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        new vscode.Position(0, 0),
                        new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
                    );
                    workspaceEdit.replace(document.uri, fullRange, newText);

                    const success = await vscode.workspace.applyEdit(workspaceEdit);

                    if (success) {
                        paragraph.status = ParagraphStatus.Rejected;
                        this.cleanupParagraphFromDiffManager(paragraph, editor);
                        this._onDidChangeParagraphCorrections.fire();
                        this.triggerStatusBarUpdate();
                        console.log(`[FallbackReject] 备用方法拒绝成功: ${paragraph.id}`);
                        return;
                    }
                }
            }

            // 方法2：如果上述方法失败，直接清理状态
            console.warn(`[FallbackReject] 无法恢复原始文本，直接清理状态: ${paragraph.id}`);
            paragraph.status = ParagraphStatus.Rejected;
            this.cleanupParagraphFromDiffManager(paragraph, editor);
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();

        } catch (error) {
            console.error(`[FallbackReject] 备用拒绝方法也失败:`, error);
            // 最后的兜底：至少清理状态，避免按钮消失但diff还在的情况
            paragraph.status = ParagraphStatus.Rejected;
            this.cleanupParagraphFromDiffManager(paragraph, editor);
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();
            throw error; // 重新抛出错误，让上层处理
        }
    }

    /**
     * 拒绝段落后重新计算所有段落位置（当有行数变化时）
     */
    private async recalculateAllParagraphsAfterReject(editor: vscode.TextEditor, rejectedParagraph: ParagraphCorrection): Promise<void> {
        if (!this.diffManager) {
            return;
        }

        console.log(`[RecalculateAfterReject] 开始重新计算段落位置，被拒绝段落: ${rejectedParagraph.id}`);

        try {
            // 1. 清除所有现有的装饰和changes
            this.diffManager.clearDecorationsForEditor(editor);
            this.editorStateManager.setChanges(editor, []);

            // 2. 获取当前文档内容，重新分析段落结构
            const currentText = editor.document.getText();
            const currentParagraphs = this.splitIntoParagraphs(currentText);

            // 3. 获取所有段落纠正信息，按原始顺序排序
            const corrections = this.editorStateManager.getParagraphCorrections(editor);
            const pendingCorrections = corrections.filter(p => p.status === ParagraphStatus.Pending);

            // 按段落ID中的行号排序，确保按文档顺序处理
            pendingCorrections.sort((a, b) => {
                const aStartLine = parseInt(a.id.split('-')[0]);
                const bStartLine = parseInt(b.id.split('-')[0]);
                return aStartLine - bStartLine;
            });

            console.log(`[RecalculateAfterReject] 当前文档有 ${currentParagraphs.length} 个段落，${pendingCorrections.length} 个待处理纠正`);

            // 4. 重新匹配段落：现在查找纠正后的文本而不是原始文本
            let currentParagraphIndex = 0;

            for (const correction of pendingCorrections) {
                console.log(`[RecalculateAfterReject] 处理段落 ${correction.id}，查找纠正后文本: "${correction.correctedText}"`);

                // 从当前位置开始查找匹配的段落
                let foundMatch = false;
                for (let i = currentParagraphIndex; i < currentParagraphs.length; i++) {
                    const currentPara = currentParagraphs[i];

                    // 检查是否匹配纠正后的文本（因为文档中现在是纠正后的内容）
                    if (correction.correctedText && this.isParagraphMatch(correction.correctedText, currentPara.content)) {
                        // 计算新的range
                        const newRange = new vscode.Range(
                            new vscode.Position(currentPara.startLine, 0),
                            new vscode.Position(currentPara.endLine, editor.document.lineAt(currentPara.endLine).text.length)
                        );

                        // 更新段落的range
                        correction.range = newRange;

                        // 重新添加到DiffManager
                        this.diffManager.addChange(
                            newRange,
                            correction.originalText,
                            correction.correctedText,
                            editor
                        );

                        console.log(`[RecalculateAfterReject] 重新定位段落 ${correction.id}: L${newRange.start.line + 1}-L${newRange.end.line + 1} (匹配到文档段落 ${i})`);

                        currentParagraphIndex = i + 1; // 下次从下一个段落开始查找
                        foundMatch = true;
                        break;
                    }
                }

                if (!foundMatch) {
                    console.warn(`[RecalculateAfterReject] 无法为段落 ${correction.id} 找到匹配的位置，尝试原始文本匹配`);

                    // 如果找不到纠正后的文本，尝试查找原始文本（可能段落已经被拒绝了）
                    for (let i = currentParagraphIndex; i < currentParagraphs.length; i++) {
                        const currentPara = currentParagraphs[i];

                        if (this.isParagraphMatch(correction.originalText, currentPara.content)) {
                            const newRange = new vscode.Range(
                                new vscode.Position(currentPara.startLine, 0),
                                new vscode.Position(currentPara.endLine, editor.document.lineAt(currentPara.endLine).text.length)
                            );

                            correction.range = newRange;
                            currentParagraphIndex = i + 1;
                            foundMatch = true;
                            console.log(`[RecalculateAfterReject] 通过原始文本重新定位段落 ${correction.id}: L${newRange.start.line + 1}-L${newRange.end.line + 1}`);
                            break;
                        }
                    }
                }

                if (!foundMatch) {
                    console.warn(`[RecalculateAfterReject] 完全无法为段落 ${correction.id} 找到匹配的位置，可能需要手动处理`);
                }
            }

            // 5. 强制更新装饰
            this.diffManager.updateDecorationsForEditor(editor);

            console.log(`[RecalculateAfterReject] 重新计算完成`);

        } catch (error) {
            console.error(`[RecalculateAfterReject] 重新计算失败:`, error);
            // 如果重新计算失败，至少清理被拒绝段落的状态
            this.cleanupParagraphFromDiffManager(rejectedParagraph, editor);
        }
    }

    /**
     * 安全的段落位置重新计算方法（处理非顺序拒绝的情况）
     */
    private async recalculateAllParagraphsAfterRejectSafe(editor: vscode.TextEditor, rejectedParagraph: ParagraphCorrection): Promise<void> {
        if (!this.diffManager) {
            return;
        }

        console.log(`[RecalculateSafe] 开始安全重新计算段落位置，被拒绝段落: ${rejectedParagraph.id}`);

        try {
            // 1. 获取当前所有段落纠正信息
            const corrections = this.editorStateManager.getParagraphCorrections(editor);
            const pendingCorrections = corrections.filter(p => p.status === ParagraphStatus.Pending);
            const acceptedCorrections = corrections.filter(p => p.status === ParagraphStatus.Accepted);
            const rejectedCorrections = corrections.filter(p => p.status === ParagraphStatus.Rejected);

            console.log(`[RecalculateSafe] 当前状态: ${pendingCorrections.length} 待处理, ${acceptedCorrections.length} 已接受, ${rejectedCorrections.length} 已拒绝`);

            // 2. 清除所有现有的装饰和changes
            this.diffManager.clearDecorationsForEditor(editor);
            this.editorStateManager.setChanges(editor, []);

            // 3. 获取当前文档内容，重新分析段落结构
            const currentText = editor.document.getText();
            const currentParagraphs = this.splitIntoParagraphs(currentText);

            console.log(`[RecalculateSafe] 当前文档有 ${currentParagraphs.length} 个段落`);

            // 4. 只为待处理的段落重新计算位置和创建diff
            // 按段落ID中的行号排序，确保按文档顺序处理
            pendingCorrections.sort((a, b) => {
                const aStartLine = parseInt(a.id.split('-')[0]);
                const bStartLine = parseInt(b.id.split('-')[0]);
                return aStartLine - bStartLine;
            });

            let currentParagraphIndex = 0;

            for (const correction of pendingCorrections) {
                console.log(`[RecalculateSafe] 处理待处理段落 ${correction.id}`);

                // 从当前位置开始查找匹配的段落
                let foundMatch = false;
                for (let i = currentParagraphIndex; i < currentParagraphs.length; i++) {
                    const currentPara = currentParagraphs[i];

                    // 检查是否匹配纠正后的文本（因为文档中现在是纠正后的内容）
                    if (correction.correctedText && this.isParagraphMatch(correction.correctedText, currentPara.content)) {
                        // 计算新的range
                        const newRange = new vscode.Range(
                            new vscode.Position(currentPara.startLine, 0),
                            new vscode.Position(currentPara.endLine, editor.document.lineAt(currentPara.endLine).text.length)
                        );

                        // 更新段落的range
                        correction.range = newRange;

                        // 重新添加到DiffManager
                        this.diffManager.addChange(
                            newRange,
                            correction.originalText,
                            correction.correctedText,
                            editor
                        );

                        console.log(`[RecalculateSafe] 重新定位段落 ${correction.id}: L${newRange.start.line + 1}-L${newRange.end.line + 1}`);

                        currentParagraphIndex = i + 1;
                        foundMatch = true;
                        break;
                    }
                }

                // 如果找不到纠正后的文本，尝试查找原始文本
                if (!foundMatch) {
                    for (let i = currentParagraphIndex; i < currentParagraphs.length; i++) {
                        const currentPara = currentParagraphs[i];

                        if (this.isParagraphMatch(correction.originalText, currentPara.content)) {
                            const newRange = new vscode.Range(
                                new vscode.Position(currentPara.startLine, 0),
                                new vscode.Position(currentPara.endLine, editor.document.lineAt(currentPara.endLine).text.length)
                            );

                            correction.range = newRange;
                            currentParagraphIndex = i + 1;
                            foundMatch = true;
                            console.log(`[RecalculateSafe] 通过原始文本重新定位段落 ${correction.id}: L${newRange.start.line + 1}-L${newRange.end.line + 1}`);
                            break;
                        }
                    }
                }

                if (!foundMatch) {
                    console.warn(`[RecalculateSafe] 无法为段落 ${correction.id} 找到匹配的位置，可能需要标记为错误状态`);
                    // 可以考虑将无法定位的段落标记为错误状态
                    // correction.status = ParagraphStatus.Error;
                }
            }

            // 5. 强制更新装饰
            this.diffManager.updateDecorationsForEditor(editor);

            console.log(`[RecalculateSafe] 安全重新计算完成`);

        } catch (error) {
            console.error(`[RecalculateSafe] 安全重新计算失败:`, error);
            // 如果重新计算失败，至少清理被拒绝段落的状态
            this.cleanupParagraphFromDiffManager(rejectedParagraph, editor);
        }
    }

    /**
     * 检查两个段落是否匹配
     */
    private isParagraphMatch(originalText: string, currentText: string): boolean {
        // 标准化文本进行比较
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
        const normalizedOriginal = normalize(originalText);
        const normalizedCurrent = normalize(currentText);

        // 完全匹配
        if (normalizedOriginal === normalizedCurrent) {
            return true;
        }

        // 检查是否包含关系（处理部分匹配的情况）
        if (normalizedCurrent.includes(normalizedOriginal) || normalizedOriginal.includes(normalizedCurrent)) {
            return true;
        }

        // 检查相似度（简单的字符匹配）
        const similarity = this.calculateTextSimilarity(normalizedOriginal, normalizedCurrent);
        return similarity > 0.8; // 80%相似度阈值
    }

    /**
     * 计算文本相似度
     */
    private calculateTextSimilarity(text1: string, text2: string): number {
        if (text1 === text2) return 1.0;
        if (text1.length === 0 || text2.length === 0) return 0.0;

        const longer = text1.length > text2.length ? text1 : text2;
        const shorter = text1.length > text2.length ? text2 : text1;

        if (longer.length === 0) return 1.0;

        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }

    /**
     * 计算编辑距离
     */
    private levenshteinDistance(str1: string, str2: string): number {
        const matrix = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    /**
     * 从DiffManager中清理段落相关状态
     */
    private cleanupParagraphFromDiffManager(paragraph: ParagraphCorrection, editor: vscode.TextEditor): void {
        if (!this.diffManager) {
            return;
        }

        try {
            console.log(`[CleanupDiff] 清理段落 ${paragraph.id} 的diff状态`);

            // 查找并移除相关的ChangeInfo
            const changeInfo = this.findChangeInfoForParagraph(paragraph);
            if (changeInfo) {
                console.log(`[CleanupDiff] 找到对应的ChangeInfo，移除中...`);

                // 使用DiffManager的公开方法移除change
                const changes = this.editorStateManager.getChanges(editor);
                const index = changes.indexOf(changeInfo);
                if (index > -1) {
                    // 直接从changes数组中移除
                    this.editorStateManager.removeChange(editor, changeInfo);
                    console.log(`[CleanupDiff] 已从changes列表中移除ChangeInfo`);
                }

                // 清理webview面板
                if (changeInfo.webviewPanel) {
                    changeInfo.webviewPanel.dispose();
                    changeInfo.webviewPanel = undefined;
                }
            } else {
                console.warn(`[CleanupDiff] 未找到段落 ${paragraph.id} 对应的ChangeInfo`);
            }

            // 强制更新装饰
            this.diffManager.updateDecorationsForEditor(editor);
            console.log(`[CleanupDiff] 段落 ${paragraph.id} 的diff状态清理完成`);
        } catch (error) {
            console.warn('清理DiffManager状态时出错:', error);
        }
    }

    /**
     * 文档重构后重建DiffManager状态
     */
    private async rebuildDiffManagerAfterDocumentReconstruction(editor: vscode.TextEditor): Promise<void> {
        if (!this.diffManager) {
            return;
        }

        // 1. 清除所有现有的装饰和changes
        this.diffManager.clearDecorationsForEditor(editor);
        this.editorStateManager.setChanges(editor, []);

        // 2. 重新计算所有段落的范围
        this.recalculateAllParagraphRanges(editor);

        // 3. 为仍然处于Pending状态的段落重新创建ChangeInfo
        const corrections = this.editorStateManager.getParagraphCorrections(editor);
        const pendingCorrections = corrections.filter(p => p.status === ParagraphStatus.Pending);

        for (const paragraph of pendingCorrections) {
            if (paragraph.correctedText && paragraph.correctedText !== paragraph.originalText) {
                // 重新添加change到DiffManager
                this.diffManager.addChange(
                    paragraph.range,
                    paragraph.originalText,
                    paragraph.correctedText,
                    editor
                );
            }
        }

        // 4. 强制更新装饰
        this.diffManager.updateDecorationsForEditor(editor);
    }

    /**
     * 更新其他段落的范围，避免完全重建装饰
     */
    private updateOtherParagraphRanges(editor: vscode.TextEditor, rejectedParagraph: ParagraphCorrection): void {
        // 只重新计算所有段落的范围
        this.recalculateAllParagraphRanges(editor);

        // 只更新DiffManager中其他段落的装饰位置
        if (this.diffManager) {
            // 强制更新装饰
            this.diffManager.updateDecorationsForEditor(editor);
        }
    }

    /**
     * 通过文档重建的方式恢复段落
     * 这种方法更可靠，避免了range错误的问题
     */
    private async rejectParagraphByDocumentReconstruction(
        editor: vscode.TextEditor,
        paragraph: ParagraphCorrection
    ): Promise<void> {
        console.log(`DOCUMENT_RECONSTRUCTION_DEBUG:`);
        console.log(`  TARGET_PARAGRAPH_ID: ${paragraph.id}`);
        console.log(`  ORIGINAL_TEXT: "${paragraph.originalText}"`);
        console.log(`  CORRECTED_TEXT: "${paragraph.correctedText}"`);

        const document = editor.document;
        const currentFullText = document.getText();

        console.log(`  CURRENT_FULL_TEXT: "${currentFullText}"`);

        // 查找纠正后的文本在当前文档中的位置
        const correctedText = paragraph.correctedText || '';
        const originalText = paragraph.originalText;

        // 首先查找纠正后的文本
        const correctedTextIndex = currentFullText.indexOf(correctedText);

        if (correctedTextIndex === -1) {
            console.warn(`  CORRECTED_TEXT_NOT_FOUND, cannot restore`);
            return;
        }

        console.log(`  FOUND_CORRECTED_TEXT_AT_INDEX: ${correctedTextIndex}`);

        // 检查原始文本是否已经存在于文档中（在不同位置）
        const originalTextIndex = currentFullText.indexOf(originalText);

        if (originalTextIndex !== -1 && originalTextIndex !== correctedTextIndex) {
            console.log(`  ORIGINAL_TEXT_ALREADY_EXISTS_AT_INDEX: ${originalTextIndex}`);
            console.log(`  FOUND_BOTH_TEXTS, removing corrected text to avoid duplication`);

            // 移除纠正后的文本，保留原始文本
            const newFullText: string = currentFullText.substring(0, correctedTextIndex) +
                                       currentFullText.substring(correctedTextIndex + correctedText.length);

            console.log(`  NEW_FULL_TEXT_AFTER_REMOVING_CORRECTED: "${newFullText}"`);

            // 使用更安全的方式替换文档内容
            let editResult = false;
            let retryCount = 0;
            const maxRetries = 3;

            while (!editResult && retryCount < maxRetries) {
                retryCount++;
                console.log(`DUPLICATE_REMOVAL_EDIT_ATTEMPT_${retryCount}`);

                const currentDocument = editor.document;
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(currentDocument.lineCount - 1,
                        currentDocument.lineAt(currentDocument.lineCount - 1).text.length)
                );

                editResult = await editor.edit(editBuilder => {
                    editBuilder.replace(fullRange, newFullText);
                }, {
                    undoStopBefore: true,
                    undoStopAfter: true
                });

                console.log(`DUPLICATE_REMOVAL_EDIT_ATTEMPT_${retryCount}_RESULT: ${editResult}`);

                if (!editResult && retryCount < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }

            console.log(`DOCUMENT_RECONSTRUCTION_COMPLETED: removed duplicate corrected text, final edit result: ${editResult}`);

            // 验证编辑后的内容
            const finalText = editor.document.getText();
            console.log(`FINAL_TEXT_AFTER_REMOVING_DUPLICATE: "${finalText}"`);

            if (finalText !== newFullText) {
                console.error(`MISMATCH_AFTER_REMOVING_DUPLICATE! Expected: "${newFullText}", Got: "${finalText}"`);
                await this.fallbackDocumentEdit(editor, newFullText);
            }
            return;
        }

        // 检查原始文本是否已经在纠正后文本的位置
        if (originalTextIndex === correctedTextIndex) {
            console.log(`  ORIGINAL_TEXT_ALREADY_AT_CORRECTED_POSITION, no action needed`);
            return;
        }

        // 标准逻辑：将纠正后的文本替换为原始文本
        const newFullText = currentFullText.substring(0, correctedTextIndex) +
                           paragraph.originalText +
                           currentFullText.substring(correctedTextIndex + correctedText.length);

        console.log(`  NEW_FULL_TEXT: "${newFullText}"`);

        // 使用更安全的方式替换文档内容
        let editResult = false;
        let retryCount = 0;
        const maxRetries = 3;

        while (!editResult && retryCount < maxRetries) {
            retryCount++;
            console.log(`EDIT_ATTEMPT_${retryCount}`);

            // 重新获取当前文档状态
            const currentDocument = editor.document;
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(currentDocument.lineCount - 1,
                    currentDocument.lineAt(currentDocument.lineCount - 1).text.length)
            );

            try {
                // 优先使用WorkspaceEdit进行更可靠的编辑
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.replace(currentDocument.uri, fullRange, newFullText);

                editResult = await vscode.workspace.applyEdit(workspaceEdit);

                if (!editResult) {
                    // 如果WorkspaceEdit失败，回退到直接编辑器操作
                    console.warn(`WorkspaceEdit failed on attempt ${retryCount}, falling back to direct editor edit`);
                    editResult = await editor.edit(editBuilder => {
                        editBuilder.replace(fullRange, newFullText);
                    }, {
                        undoStopBefore: true,
                        undoStopAfter: true
                    });
                }
            } catch (error) {
                console.warn(`Edit attempt ${retryCount} failed:`, error);
                editResult = false;
            }

            console.log(`EDIT_ATTEMPT_${retryCount}_RESULT: ${editResult}`);

            if (!editResult && retryCount < maxRetries) {
                console.log(`EDIT_FAILED, waiting before retry...`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        console.log(`DOCUMENT_RECONSTRUCTION_COMPLETED, final edit result: ${editResult}`);

        // 验证编辑后的内容
        const finalText = editor.document.getText();
        console.log(`FINAL_TEXT_AFTER_EDIT: "${finalText}"`);

        if (finalText !== newFullText) {
            console.error(`MISMATCH! Expected: "${newFullText}", Got: "${finalText}"`);
            console.error(`EDIT_OPERATION_FAILED - attempting alternative approach`);

            // 如果直接替换失败，尝试逐步替换
            await this.fallbackDocumentEdit(editor, newFullText);
        }
    }

    /**
     * 备用文档编辑方法，当直接替换失败时使用
     */
    private async fallbackDocumentEdit(editor: vscode.TextEditor, targetText: string): Promise<void> {
        console.log(`FALLBACK_DOCUMENT_EDIT: attempting alternative approach`);

        try {
            // 方法1：使用 WorkspaceEdit
            const workspaceEdit = new vscode.WorkspaceEdit();
            const document = editor.document;
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
            );

            workspaceEdit.replace(document.uri, fullRange, targetText);
            const workspaceEditResult = await vscode.workspace.applyEdit(workspaceEdit);

            console.log(`WORKSPACE_EDIT_RESULT: ${workspaceEditResult}`);

            if (workspaceEditResult) {
                console.log(`FALLBACK_EDIT_SUCCESS via WorkspaceEdit`);
                return;
            }
        } catch (error) {
            console.error(`WORKSPACE_EDIT_FAILED:`, error);
        }

        // 方法2：如果 WorkspaceEdit 也失败，尝试分段替换
        console.log(`ATTEMPTING_SEGMENTED_REPLACEMENT`);
        await this.segmentedDocumentReplace(editor, targetText);
    }

    /**
     * 分段替换文档内容
     */
    private async segmentedDocumentReplace(editor: vscode.TextEditor, targetText: string): Promise<void> {
        console.log(`SEGMENTED_DOCUMENT_REPLACE: starting`);

        const document = editor.document;
        const currentText = document.getText();
        const currentLines = currentText.split('\n');
        const targetLines = targetText.split('\n');

        console.log(`CURRENT_LINES: ${currentLines.length}, TARGET_LINES: ${targetLines.length}`);

        // 逐行比较和替换
        const editResult = await editor.edit(editBuilder => {
            // 如果行数不同，先处理行数差异
            if (targetLines.length !== currentLines.length) {
                // 简单处理：替换整个文档
                const fullRange = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
                );
                editBuilder.replace(fullRange, targetText);
            } else {
                // 逐行替换不同的行
                for (let i = 0; i < targetLines.length; i++) {
                    if (i < currentLines.length && currentLines[i] !== targetLines[i]) {
                        const lineRange = new vscode.Range(
                            new vscode.Position(i, 0),
                            new vscode.Position(i, currentLines[i].length)
                        );
                        editBuilder.replace(lineRange, targetLines[i]);
                    }
                }
            }
        }, {
            undoStopBefore: true,
            undoStopAfter: true
        });

        console.log(`SEGMENTED_EDIT_RESULT: ${editResult}`);
    }



    /**
     * 打印编辑器的完整内容，用于调试
     */
    private printEditorContent(editor: vscode.TextEditor, label: string): void {
        const document = editor.document;
        const fullText = document.getText();
        const lines = fullText.split('\n');

        console.log(`${label}_EDITOR_CONTENT:`);
        console.log(`  TOTAL_LINES: ${lines.length}`);
        console.log(`  FULL_TEXT: "${fullText}"`);
        console.log(`  LINE_BY_LINE:`);
        lines.forEach((line, index) => {
            console.log(`    L${index + 1}: "${line}"`);
        });
        console.log(`${label}_EDITOR_CONTENT_END`);
    }
}

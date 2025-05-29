import * as vscode from 'vscode';
import { EditorStateManager } from './editorStateManager';
import { DiffHandlerService } from './diffHandlerService';
import { OperationLockService } from './operationLockService';
import { DocumentEditService } from './documentEditService';
import { ParagraphModel, ParagraphStatus, DocumentParagraphs } from '../models/paragraphModel';
import { TextProcessingService } from './textProcessingService';
import { DiffManager } from '../diff/diffManager';

/**
 * 段落操作服务 - 使用新的段落模型处理段落的接受/拒绝操作
 */
export class ParagraphActionService {
    private editorStateManager: EditorStateManager;
    private diffHandlerService: DiffHandlerService; // Kept for now, review if still needed
    private operationLockService: OperationLockService;
    private documentEditService: DocumentEditService;
    private textProcessingService: TextProcessingService;
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void>;
    private diffManager: DiffManager | undefined;

    constructor(
        editorStateManager: EditorStateManager,
        diffHandlerService: DiffHandlerService, // Kept in params for now, review if still needed by other methods
        operationLockService: OperationLockService,
        documentEditService: DocumentEditService,
        textProcessingService: TextProcessingService,
        onDidChangeParagraphCorrections: vscode.EventEmitter<void>,
        diffManager: DiffManager // Added DiffManager as a direct dependency
    ) {
        this.editorStateManager = editorStateManager;
        this.diffHandlerService = diffHandlerService; // Kept for now
        this.operationLockService = operationLockService;
        this.documentEditService = documentEditService;
        this.textProcessingService = textProcessingService;
        this._onDidChangeParagraphCorrections = onDidChangeParagraphCorrections;
        this.diffManager = diffManager; // Assign directly from constructor parameter
    }

    /**
     * 获取文档的段落集合
     */
    public getDocumentParagraphs(editor: vscode.TextEditor): DocumentParagraphs | undefined {
        const state = this.editorStateManager.getEditorState(editor);
        return state.documentParagraphs as DocumentParagraphs;
    }

    /**
     * 设置文档的段落集合
     */
    private setDocumentParagraphs(editor: vscode.TextEditor, paragraphs: DocumentParagraphs): void {
        const state = this.editorStateManager.getEditorState(editor);
        state.documentParagraphs = paragraphs;
        this.editorStateManager.updateEditorState(editor, state);
    }

    /**
     * 获取指定ID的段落
     */
    public getParagraphById(id: string, editor: vscode.TextEditor): ParagraphModel | undefined {
        const docParagraphs = this.getDocumentParagraphs(editor);
        if (!docParagraphs) return undefined;
        
        return docParagraphs.paragraphs.find(p => p.id === id);
    }

    /**
     * 接受段落修改
     */
    public async acceptParagraph(paragraphId: string, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending) {
            return;
        }

        // 尝试获取操作锁
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'accept', paragraphId);
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
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

            // 更新段落状态
            paragraph.status = ParagraphStatus.Accepted;

            // 更新文档内容（不需要做任何事情，因为文档已经包含纠正后的内容）
            
            // 使用diffHandlerService清理装饰 (使用新接口方法)
            console.log(`[AcceptParagraph] 清理段落装饰信息`);
            this.diffHandlerService.cleanupParagraphFromDiffManager(paragraph, editor);
            
            // 强制清理所有装饰，确保完全清除diff信息
            if (this.diffManager) {
                this.diffManager.updateDecorationsForEditor(editor);
            }

            // 触发更新
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();

        } finally {
            this.operationLockService.releaseOperationLock(lockKey);
        }
    }

    /**
     * 拒绝段落修改
     */
    public async rejectParagraph(paragraphId: string, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending) {
            return;
        }

        // 尝试获取操作锁
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'reject', paragraphId);
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
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

            const docParagraphs = this.getDocumentParagraphs(editor);
            if (!docParagraphs) {
                throw new Error('无法获取文档段落集合');
            }
            
            const contentBeforeRejection = paragraph.correctedContent; // 保存拒绝前的纠正内容
            const originalContent = paragraph.originalContent; // 获取原始内容，方便引用

            // 更新段落状态
            paragraph.correctedContent = null; // 清除纠正内容
            paragraph.status = ParagraphStatus.Rejected;

            // 如果之前有纠正内容，并且该纠正内容与原始内容不同，则需要在编辑器中恢复原始内容
            if (contentBeforeRejection !== null && contentBeforeRejection !== originalContent) {
                console.log(`[RejectParagraph] 段落 ${paragraphId} 内容需要从纠正状态恢复为原始内容。`);
                
                // 计算行数变化
                const correctedLines = contentBeforeRejection.split('\n').length;
                const originalLines = originalContent.split('\n').length;
                const lineDelta = originalLines - correctedLines; // 正值表示行数增加，负值表示行数减少
                
                console.log(`[RejectParagraph] 段落 ${paragraphId} 行数变化: ${lineDelta}行 (原始: ${originalLines}行, 纠正: ${correctedLines}行)`);
                
                // 当前 paragraph.range 对应的是 contentBeforeRejection 在编辑器中的位置
                // 我们需要将这部分文本替换为 originalContent
                // 优先尝试 editor.edit，如果失败则尝试 WorkspaceEdit
                const editSuccess = await editor.edit(editBuilder => {
                    editBuilder.replace(paragraph.range, originalContent);
                });

                if (!editSuccess) {
                    console.warn('[RejectParagraph] editor.edit 失败，尝试使用 WorkspaceEdit。');
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    workspaceEdit.replace(editor.document.uri, paragraph.range, originalContent);
                    const wsSuccess = await vscode.workspace.applyEdit(workspaceEdit);
                    if (!wsSuccess) {
                        throw new Error('无法恢复段落原始内容（editor.edit 和 workspace.applyEdit 均失败）');
                    }
                }
                
                // 文本恢复后，段落在文档中的实际范围可能已更改（如果行数不同）。
                // 调用 updateParagraphRange 更新内存中 paragraph.range 的信息。
                paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
                
                // 如果行数发生变化，更新后续段落的位置信息
                if (lineDelta !== 0) {
                    // 获取当前段落在段落数组中的索引
                    const currentIndex = docParagraphs.paragraphs.findIndex(p => p.id === paragraphId);
                    if (currentIndex !== -1 && currentIndex < docParagraphs.paragraphs.length - 1) {
                        console.log(`[RejectParagraph] 开始更新后续段落的位置信息，当前段落索引: ${currentIndex}`);
                        
                        // 更新后续段落的位置信息
                        for (let i = currentIndex + 1; i < docParagraphs.paragraphs.length; i++) {
                            const nextParagraph = docParagraphs.paragraphs[i];
                            
                            // 更新段落的起始行号和结束行号
                            nextParagraph.startLineNumber = nextParagraph.startLineNumber + lineDelta;
                            nextParagraph.startLine = nextParagraph.startLine + lineDelta;
                            nextParagraph.endLine = nextParagraph.endLine + lineDelta;
                            
                            // 更新段落的范围信息
                            nextParagraph.range = this.textProcessingService.updateParagraphRange(nextParagraph);
                            
                            console.log(`[RejectParagraph] 更新段落 ${nextParagraph.id} 的位置信息，新的起始行: ${nextParagraph.startLine}`);
                            
                            // 如果段落有对应的diff信息，也需要更新
                            const changeInfo = this.diffHandlerService.findChangeInfoForParagraphModel(nextParagraph, editor);
                            if (changeInfo) {
                                console.log(`[RejectParagraph] 更新段落 ${nextParagraph.id} 的diff信息`);
                                // 移除旧的diff信息
                                this.editorStateManager.removeChange(editor, changeInfo);
                                
                                // 添加新的diff信息，使用更新后的范围
                                if (this.diffManager && nextParagraph.correctedContent !== null) {
                                    this.diffManager.addChange(
                                        nextParagraph.range, 
                                        nextParagraph.originalContent, 
                                        nextParagraph.correctedContent, 
                                        editor
                                    );
                                }
                            }
                        }
                        
                        // 当行数变化时，需要完全重建所有diff信息
                        console.log(`[RejectParagraph] 开始重建所有diff信息`);
                        
                        // 1. 先清除所有现有的changes
                        this.editorStateManager.setChanges(editor, []);
                        
                        // 2. 清除所有装饰
                        if (this.diffManager) {
                            this.diffManager.clearDecorationsForEditor(editor);
                        }
                        
                        // 3. 重新为所有Pending状态的段落创建新的diff信息
                        for (const p of docParagraphs.paragraphs) {
                            if (p.status === ParagraphStatus.Pending && p.correctedContent !== null) {
                                console.log(`[RejectParagraph] 为段落 ${p.id} 重建新的diff信息`);
                                if (this.diffManager) {
                                    this.diffManager.addChange(
                                        p.range, 
                                        p.originalContent, 
                                        p.correctedContent, 
                                        editor
                                    );
                                }
                            }
                        }
                    }
                }
            } else {
                // 编辑器中的文本无需更改（可能没有纠正内容，或纠正内容与原始内容相同）。
                // 但仍需调用 updateParagraphRange，以确保 paragraph.range 基于 originalContent 正确计算，
                // 因为后续逻辑可能依赖此范围的准确性。
                console.log(`[RejectParagraph] 段落 ${paragraphId} 内容无需在编辑器中更改，仅更新范围信息。`);
                paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
            }

            // 保存更新后的段落集合
            this.setDocumentParagraphs(editor, docParagraphs);

            // 使用diffHandlerService清理装饰 (使用新接口方法)
            console.log(`[RejectParagraph] 清理段落装饰信息`);
            this.diffHandlerService.cleanupParagraphFromDiffManager(paragraph, editor);
            
            // 强制清理所有装饰，确保完全清除diff信息
            if (this.diffManager) {
                this.diffManager.updateDecorationsForEditor(editor);
            }

            // 触发更新
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();

            console.log(`[RejectParagraph] 段落拒绝成功: ${paragraphId}`);

        } catch (error) {
            console.error(`[RejectParagraph] 拒绝段落失败:`, error);
            vscode.window.showErrorMessage(`拒绝段落失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // 确保释放操作锁
            this.operationLockService.releaseOperationLock(lockKey);
        }
    }

    /**
     * 接受所有待处理段落
     */
    public async acceptAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        // 尝试获取全局操作锁
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'acceptAll');
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
            console.warn(`[AcceptAll] 编辑器正在处理其他操作，跳过全部接受`);
            vscode.window.showWarningMessage('正在处理其他操作，请稍后再试');
            return;
        }

        try {
            const docParagraphs = this.getDocumentParagraphs(editor);
            if (!docParagraphs) {
                throw new Error('无法获取文档段落集合');
            }

            // 更新所有待处理段落的状态
            let acceptedCount = 0;
            const paragraphsToCleanDecorations: ParagraphModel[] = [];
            
            for (const paragraph of docParagraphs.paragraphs) {
                if (paragraph.status === ParagraphStatus.Pending) {
                    paragraph.status = ParagraphStatus.Accepted;
                    paragraphsToCleanDecorations.push(paragraph);
                    acceptedCount++;
                }
            }

            // 保存更新后的段落集合
            this.setDocumentParagraphs(editor, docParagraphs);

            // 清理装饰信息 - 使用diffHandlerService
            console.log(`[AcceptAll] 清理所有段落装饰信息`);
            
            // 清理每个段落的diff信息
            for (const p of paragraphsToCleanDecorations) {
                this.diffHandlerService.cleanupParagraphFromDiffManager(p, editor);
            }
            
            // 清理所有装饰
            if (this.diffManager) {
                this.diffManager.clearDecorationsForEditor(editor);
                this.editorStateManager.setChanges(editor, []);
            }

            // 保存文件
            if (acceptedCount > 0) {
                try {
                    await this.documentEditService.saveFile(editor);
                    console.log(`[AcceptAll] 文件已保存`);
                } catch (saveError) {
                    console.error(`[AcceptAll] 保存文件失败:`, saveError);
                    // 不中断流程，继续执行
                }
            }

            // 触发更新
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();

            vscode.window.showInformationMessage(`已接受 ${acceptedCount} 个段落修改`);

        } catch (error) {
            console.error(`[AcceptAll] 接受所有段落失败:`, error);
            vscode.window.showErrorMessage(`接受所有段落失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.operationLockService.releaseOperationLock(lockKey);
        }
    }

    /**
     * 拒绝所有待处理段落
     */
    public async rejectAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        // 尝试获取全局操作锁
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'rejectAll');
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
            console.warn(`[RejectAll] 编辑器正在处理其他操作，跳过全部拒绝`);
            vscode.window.showWarningMessage('正在处理其他操作，请稍后再试');
            return;
        }

        try {
            const docParagraphs = this.getDocumentParagraphs(editor);
            if (!docParagraphs) {
                throw new Error('无法获取文档段落集合');
            }

            let rejectedCount = 0;
            const paragraphsToCleanDecorations: ParagraphModel[] = [];
            let cumulativeLineDelta = 0; // 跟踪累计行变化

            for (const paragraph of docParagraphs.paragraphs) {
                // 计算当前段落在文档中的实际起始行（考虑前面段落行数变化的影响）
                const currentDocStartLine = paragraph.range.start.line + cumulativeLineDelta;
                const currentDocEndLine = paragraph.range.end.line + cumulativeLineDelta;
                // 当前段落在编辑器中实际占据的范围
                const currentParagraphDocRange = new vscode.Range(
                    currentDocStartLine,
                    paragraph.range.start.character, // 假设起始字符不变
                    currentDocEndLine,
                    paragraph.range.end.character   // 假设结束字符不变
                );

                // 更新段落对象中的起始行号（重要，updateParagraphRange会用到）
                paragraph.startLineNumber = currentDocStartLine;

                if (paragraph.status === ParagraphStatus.Pending) {
                    const contentBeforeRejection = paragraph.correctedContent;
                    const originalContent = paragraph.originalContent;

                    // 更新段落状态和内容（内存中）
                    paragraph.status = ParagraphStatus.Rejected;
                    paragraph.correctedContent = null;
                    
                    rejectedCount++;
                    paragraphsToCleanDecorations.push(paragraph);

                    if (contentBeforeRejection !== null && contentBeforeRejection !== originalContent) {
                        // 此段落内容需要从纠正状态恢复为原始内容
                        const linesInEditorBeforeEdit = currentParagraphDocRange.end.line - currentParagraphDocRange.start.line + 1;

                        const success = await editor.edit(editBuilder => {
                            editBuilder.replace(currentParagraphDocRange, originalContent);
                        });

                        if (!success) {
                            console.error(`[RejectAll] 恢复段落 ${paragraph.id} 的原始内容失败`);
                            // 可以选择抛出错误中断，或记录错误并继续处理其他段落
                            // throw new Error(`无法恢复段落 ${paragraph.id} 的原始内容`);
                            // 为了尽可能多地拒绝，我们这里选择继续，但后续范围可能不准
                        }

                        // 编辑器内容已更改，更新此段落在内存中的范围信息
                        // updateParagraphRange会使用更新后的paragraph.startLineNumber和originalContent
                        paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
                        
                        const linesInEditorAfterEdit = paragraph.range.end.line - paragraph.range.start.line + 1;
                        cumulativeLineDelta += (linesInEditorAfterEdit - linesInEditorBeforeEdit);
                    } else {
                        // 内容无需在编辑器中更改，但其起始行可能已变，仍需更新范围
                        paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
                        // 此段落本身没有引起行数变化
                    }
                } else {
                    // 非待处理段落，但其起始行可能因前面段落的修改而改变，同样需要更新其在内存中的范围
                    paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
                }
            }

            if (rejectedCount === 0) {
                vscode.window.showInformationMessage('没有待处理的段落需要拒绝');
                return; // 注意：finally块中的锁释放仍会执行
            }

            // 保存更新后的段落集合（包含所有段落状态和范围的更新）
            this.setDocumentParagraphs(editor, docParagraphs);

            // 全部拒绝时，强制彻底清除所有diff信息
            console.log(`[RejectAll] 强制清除所有diff信息`);
            
            // 1. 核心：先清除所有现有的 changes 状态
            this.editorStateManager.setChanges(editor, []);
            console.log(`[RejectAll] EditorStateManager changes cleared.`);
            
            // 2. 核心：立即清除所有装饰 (使用 DiffManager 的方法)
            // 3. 核心：立即尝试更新/应用装饰（此时 changes 应该是空的，所以会清除）
            //    这一步确保 applyDiffDecorations 内部的清除逻辑也被执行，并且不会因为有 (意外的) changes 而重新应用。
            console.log(`[RejectAll] Checking this.diffManager:`, this.diffManager ? 'Exists' : 'NULL or Undefined');
            if (this.diffManager) {
                this.diffManager.clearDecorationsForEditor(editor);
                console.log(`[RejectAll] DiffManager decorations cleared via clearDecorationsForEditor.`);

                this.diffManager.updateDecorationsForEditor(editor);
                console.log(`[RejectAll] DiffManager decorations updated (should be cleared as no changes).`);
            }
            
            // 不再重建任何diff信息，因为全部拒绝后不应该有任何diff信息

            // 保存文件
            if (rejectedCount > 0) {
                try {
                    await this.documentEditService.saveFile(editor);
                    console.log(`[RejectAll] 文件已保存`);
                } catch (saveError) {
                    console.error(`[RejectAll] 保存文件失败:`, saveError);
                    // 不中断流程，继续执行
                }
            }

            // 触发更新
            this._onDidChangeParagraphCorrections.fire();
            this.triggerStatusBarUpdate();

            console.log(`[RejectAll] ${rejectedCount} 个段落已成功拒绝`);

        } catch (error) {
            console.error(`[RejectAll] 拒绝所有段落失败:`, error);
            vscode.window.showErrorMessage(`拒绝所有段落失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.operationLockService.releaseOperationLock(lockKey);
        }
    }

    /**
     * 关闭错误提示
     */
    public async dismissError(paragraphId: string, editor: vscode.TextEditor): Promise<void> {
        const paragraph = this.getParagraphById(paragraphId, editor);
        if (!paragraph || paragraph.status !== ParagraphStatus.Error) {
            return;
        }

        // 更新段落状态为拒绝
        paragraph.status = ParagraphStatus.Rejected;

        // 保存更新后的段落集合
        const docParagraphs = this.getDocumentParagraphs(editor);
        if (docParagraphs) {
            this.setDocumentParagraphs(editor, docParagraphs);
        }

        // 触发更新
        this._onDidChangeParagraphCorrections.fire();
        this.triggerStatusBarUpdate();
    }

    /**
     * 触发状态栏更新
     */
    public triggerStatusBarUpdate(): void {
        // 这个方法会被其他服务调用，用于触发状态栏更新
        // 实际的状态栏更新逻辑在extension.ts中
    }
}

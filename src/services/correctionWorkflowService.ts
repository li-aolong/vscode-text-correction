import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { EditorStateManager } from './editorStateManager';
import { DiffManager } from '../diff/diffManager';
import { ApiService } from './apiService';
import { TextProcessingService } from './textProcessingService';
import { DocumentEditService } from './documentEditService';
import { CostService } from './costService';
import { ParagraphStatus } from '../models/paragraphModel';


export class CorrectionWorkflowService {
    private configManager: ConfigManager;
    private editorStateManager: EditorStateManager;
    private diffManager: DiffManager | undefined;
    private apiService: ApiService;
    private textProcessingService: TextProcessingService;
    private documentEditService: DocumentEditService;
    private costService: CostService;
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void>;

    constructor(
        configManager: ConfigManager,
        editorStateManager: EditorStateManager,
        apiService: ApiService,
        textProcessingService: TextProcessingService,
        documentEditService: DocumentEditService,
        costService: CostService,
        onDidChangeParagraphCorrections: vscode.EventEmitter<void>
    ) {
        this.configManager = configManager;
        this.editorStateManager = editorStateManager;
        this.apiService = apiService;
        this.textProcessingService = textProcessingService;
        this.documentEditService = documentEditService;
        this.costService = costService;
        this._onDidChangeParagraphCorrections = onDidChangeParagraphCorrections;
    }

    /**
     * 设置DiffManager实例
     */
    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    /**
     * 纠正整个文档的文本
     * 使用新的段落模型处理文本纠错
     */
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
        console.log(`开始文本纠错...`);

        this.clearAllCorrectionsState(editor); // 开始新的纠错前，清空旧状态

        // 获取原始文档内容
        const originalDocumentContent = editor.document.getText();

        // 创建文档段落集合
        const documentParagraphs = this.textProcessingService.createDocumentParagraphs(originalDocumentContent);

        // 保存原始文档内容和段落集合到编辑器状态中
        this.editorStateManager.updateEditorState(editor, {
            originalDocumentContent: originalDocumentContent,
            isCorrectingInProgress: true,
            documentParagraphs: documentParagraphs
        });

        // 立即显示初始进度和状态
        if (progressCallback) {
            progressCallback(0, documentParagraphs.paragraphs.length);
        }

        // 逐个处理段落
        for (let i = 0; i < documentParagraphs.paragraphs.length; i++) {
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
                console.error(`原始编辑器不再有效: ${editorUri}`);
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
                console.log('执行后台纠错 - 编辑器不可见');
            }

            // 如果是后台纠错且是第一次检测到，显示提示
            if (isBackgroundCorrection && i === 0) {
                const fileName = editorUri.split('/').pop() || '文档';
                vscode.window.showInformationMessage(`${fileName} 正在后台进行纠错，您可以继续其他工作`);
            }

            if (progressCallback) {
                progressCallback(i + 1, documentParagraphs.paragraphs.length);
            }

            const paragraph = documentParagraphs.paragraphs[i];
            if (paragraph.originalContent.trim()) {
                try {
                    // 调用API前再次检查是否已取消
                    if (this.editorStateManager.getEditorState(editor).isCancelled) {
                        console.log(`[CorrectionWorkflow] 检测到取消操作，跳过段落 ${paragraph.id} 的处理`);
                        break; // 立即跳出循环，不再处理任何段落
                    }
                    
                    // 调用API进行文本纠错
                    const apiResult = await this.apiService.correctText(paragraph.originalContent);

                    // API调用完成后再次检查是否已取消
                    if (this.editorStateManager.getEditorState(editor).isCancelled) {
                        console.log(`[CorrectionWorkflow] API调用后检测到取消操作，不应用段落 ${paragraph.id} 的修改`);
                        break; // 立即跳出循环，不再处理任何段落
                    }

                    // 计算并累计花费
                    if (apiResult.usage) {
                        this.costService.calculateAndUpdateCost(currentEditor, apiResult.usage);
                    }

                    // 只有当纠正后的内容与原始内容不同时，才设置为Pending状态
                    if (apiResult.correctedText !== paragraph.originalContent) {
                        // 更新段落的纠正内容
                        paragraph.correctedContent = apiResult.correctedText;
                        // 设置段落状态为待处理
                        paragraph.status = ParagraphStatus.Pending;

                        // 应用修改到编辑器前再次检查是否已取消
                        if (this.editorStateManager.getEditorState(editor).isCancelled) {
                            console.log(`[CorrectionWorkflow] 应用修改前检测到取消操作，不应用段落 ${paragraph.id} 的修改`);
                            break; // 立即跳出循环，不再处理任何段落
                        }
                        
                        // 应用修改到编辑器
                        await this.documentEditService.applyCorrectionToEditor(currentEditor, {
                            content: paragraph.originalContent,
                            startLine: paragraph.startLine,
                            endLine: paragraph.endLine
                        }, apiResult.correctedText);

                        // 计算行数变化
                        const originalLines = paragraph.originalContent.split('\n').length;
                        const correctedLines = apiResult.correctedText.split('\n').length;
                        const lineDelta = correctedLines - originalLines;
                        
                        // 更新当前段落范围
                        paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
                        
                        // 如果行数发生变化，更新后续段落的起始行号
                        if (lineDelta !== 0) {
                            console.log(`[CorrectionWorkflow] 段落 ${paragraph.id} 行数变化: ${lineDelta}行`);
                            
                            // 更新后续段落的起始行号
                            for (let j = i + 1; j < documentParagraphs.paragraphs.length; j++) {
                                const nextParagraph = documentParagraphs.paragraphs[j];
                                nextParagraph.startLineNumber = nextParagraph.startLineNumber + lineDelta;
                                nextParagraph.startLine = nextParagraph.startLine + lineDelta;
                                nextParagraph.endLine = nextParagraph.endLine + lineDelta;
                                console.log(`[CorrectionWorkflow] 更新后续段落 ${nextParagraph.id} 起始行号为 ${nextParagraph.startLineNumber}`);
                            }
                        }

                        // 添加差异高亮
                        if (this.diffManager) {
                            this.diffManager.addChange(paragraph.range, paragraph.originalContent, apiResult.correctedText, currentEditor);

                            // 立即强制更新装饰，确保diff显示
                            setTimeout(() => {
                                this.diffManager?.updateDecorationsForEditor(currentEditor);
                            }, 50);
                        }
                    }
                } catch (error) {
                    // 记录错误信息
                    paragraph.status = ParagraphStatus.Error;
                    paragraph.error = "纠错失败";
                    console.error(`段落 ${paragraph.id} 纠错失败:`, error);
                }
            }
        }

        // 获取最终状态
        const finalState = this.editorStateManager.getEditorState(editor);
        
        // 更新编辑器状态
        this.editorStateManager.updateEditorState(editor, {
            isCorrectingInProgress: false
        });

        // 如果操作被取消，不触发任何更新或显示任何消息
        if (finalState.isCancelled) {
            console.log(`[CorrectionWorkflow] 纠错操作已被用户取消，不进行后续处理`);
            return;
        }

        // 触发更新
        this._onDidChangeParagraphCorrections.fire();

        // 强制更新装饰，确保所有diff都正确显示
        if (this.diffManager) {
            setTimeout(() => {
                this.diffManager?.updateDecorationsForEditor(editor);
            }, 100);
        }

        if (this.diffManager && this.diffManager.hasChanges()) {
            vscode.window.showInformationMessage(`文档 "${editorUri.split('/').pop()}" 纠错完成，请使用段落旁的按钮进行接受或拒绝操作。`);
        } else {
            vscode.window.showInformationMessage(`文档 "${editorUri.split('/').pop()}" 纠错完成，未发现需要修改的内容。`);
        }
    }

    /**
     * 清空指定编辑器的段落状态和差异
     */
    public clearAllCorrectionsState(editor: vscode.TextEditor): void {
        this.editorStateManager.clearEditorCorrectionState(editor);
        if (this.diffManager) {
            this.diffManager.clearDecorationsForEditor(editor);
        }
        this._onDidChangeParagraphCorrections.fire(); // 通知 CodeLens 更新
    }

    /**
     * 触发状态栏更新
     */
    public triggerStatusBarUpdate(): void {
        // 触发状态变化事件
        this._onDidChangeParagraphCorrections.fire();

        // 延迟触发，确保状态变化被处理
        setTimeout(() => {
            this._onDidChangeParagraphCorrections.fire();
        }, 100);
    }
}

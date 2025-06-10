import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { DiffManager } from '../diff/diffManager';
import { EditorStateManager } from './editorStateManager';
import { ApiService } from './apiService';
import { TextProcessingService } from './textProcessingService';
import { DocumentEditService } from './documentEditService';
import { CostService } from './costService';
import { OperationLockService } from './operationLockService';
import { DiffHandlerService } from './diffHandlerService';
import { ParagraphActionService } from './paragraphActionService';
import { CorrectionWorkflowService } from './correctionWorkflowService';
import { SelectionCorrectionService } from './selectionCorrectionService';
import { DocumentParagraphs } from '../models/paragraphModel';

export class CorrectionService {
    // 用于通知 CodeLensProvider 更新
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeParagraphCorrections: vscode.Event<void> = this._onDidChangeParagraphCorrections.event;

    // 所有核心依赖已移至各个专注的服务类中
    
    // 第一层拆分的服务类
    private editorStateManager: EditorStateManager;
    private apiService: ApiService;
    private textProcessingService: TextProcessingService;
    private documentEditService: DocumentEditService;
    private costService: CostService;
    private operationLockService: OperationLockService;
    
    // 第二层拆分的服务类
    private diffHandlerService: DiffHandlerService;
    private paragraphActionService!: ParagraphActionService; // Definite assignment assertion
    private correctionWorkflowService: CorrectionWorkflowService;
    private selectionCorrectionService: SelectionCorrectionService;
    private diffManagerInstance: DiffManager | undefined; // Store the DiffManager instance

    constructor(configManager: ConfigManager, editorStateManager: EditorStateManager) {
        // 初始化第一层服务类
        this.editorStateManager = editorStateManager;
        this.apiService = new ApiService(configManager);
        this.textProcessingService = new TextProcessingService();
        this.documentEditService = new DocumentEditService(editorStateManager);
        this.costService = new CostService(configManager, editorStateManager);
        this.operationLockService = new OperationLockService();
        
        // 初始化第二层服务类 (部分)
        this.diffHandlerService = new DiffHandlerService(editorStateManager);
        // ParagraphActionService will be initialized in setDiffManager
        this.correctionWorkflowService = new CorrectionWorkflowService(
            configManager,
            editorStateManager,
            this.apiService,
            this.textProcessingService,
            this.documentEditService,
            this.costService,
            this._onDidChangeParagraphCorrections
        );

        // 初始化选中纠错服务
        this.selectionCorrectionService = new SelectionCorrectionService(
            editorStateManager,
            this.apiService,
            this.textProcessingService,
            this.documentEditService,
            this.operationLockService,
            this.diffHandlerService,
            this._onDidChangeParagraphCorrections
        );
    }

    // 清空指定编辑器的段落状态和差异
    public clearAllCorrectionsState(editor: vscode.TextEditor): void {
        this.correctionWorkflowService.clearAllCorrectionsState(editor);
    }


    public setDiffManager(diffManager: DiffManager): void {
        this.diffManagerInstance = diffManager; // Store it
        // 将DiffManager设置到相关服务类中
        this.diffHandlerService.setDiffManager(diffManager);
        this.correctionWorkflowService.setDiffManager(diffManager);
        this.selectionCorrectionService.setDiffManager(diffManager);

        // NOW instantiate ParagraphActionService as we have the DiffManager
        if (!this.paragraphActionService && this.diffManagerInstance) { // Ensure it's only created once
            this.paragraphActionService = new ParagraphActionService(
                this.editorStateManager,
                this.diffHandlerService, // Still passing this, as per ParagraphActionService's current constructor
                this.operationLockService,
                this.documentEditService,
                this.textProcessingService,
                this._onDidChangeParagraphCorrections,
                this.diffManagerInstance // Pass the actual DiffManager instance
            );
        } else if (this.paragraphActionService && this.diffManagerInstance) {
            // Optional: If ParagraphActionService could be reconfigured with a new DiffManager
            // (this.paragraphActionService as any).setDiffManager(this.diffManagerInstance); 
        }
    }

    /**
     * 智能全部接受：只接受仍处于Pending状态的段落
     */
    public async acceptAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        return this.paragraphActionService.acceptAllPendingParagraphs(editor);
    }

    /**
     * 基于撤销操作的全部拒绝：恢复到纠错前的原始状态
     */
    public async rejectAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        return this.paragraphActionService.rejectAllPendingParagraphs(editor);
    }

    public async correctFullText(
        editor: vscode.TextEditor,
        progressCallback?: (current: number, total: number) => void
    ): Promise<void> {
        return this.correctionWorkflowService.correctFullText(editor, progressCallback);
    }

    /**
     * 选中文本纠错
     */
    public async correctSelectedText(editor: vscode.TextEditor): Promise<void> {
        return this.selectionCorrectionService.correctSelectedText(editor);
    }

    /**
     * 检查是否有选中的文本
     */
    public hasSelection(editor: vscode.TextEditor | undefined): boolean {
        return this.selectionCorrectionService.hasSelection(editor);
    }

    /**
     * 获取当前选中文本的范围
     */
    public getSelectionRange(editor: vscode.TextEditor): vscode.Range | undefined {
        return this.selectionCorrectionService.getSelectionRange(editor);
    }

    /**
     * 获取文档段落数据
     */
    public getDocumentParagraphs(editor: vscode.TextEditor): DocumentParagraphs | undefined {
        const paragraphs = this.paragraphActionService.getDocumentParagraphs(editor);
        if (!paragraphs) {
            // 如果没有段落数据，尝试创建一个新的
            const document = editor.document;
            const documentContent = document.getText();
            const docParagraphs = this.textProcessingService.createDocumentParagraphs(documentContent);
            
            // 保存到编辑器状态
            this.editorStateManager.updateEditorState(editor, {
                documentParagraphs: docParagraphs
            });
            
            return docParagraphs;
        }
        return paragraphs;
    }



}

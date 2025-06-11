import * as vscode from 'vscode';
import { EditorStateManager } from './editorStateManager';
import { ApiService } from './apiService';
import { TextProcessingService } from './textProcessingService';
import { DocumentEditService } from './documentEditService';
import { OperationLockService } from './operationLockService';
import { DiffHandlerService } from './diffHandlerService';
import { ParagraphModel, ParagraphStatus, DocumentParagraphs } from '../models/paragraphModel';
import { DiffManager, ChangeInfo } from '../diff/diffManager';
import { v4 as uuidv4 } from 'uuid';

/**
 * 选中文本纠错服务 - 处理用户选中文本的纠错操作
 */
export class SelectionCorrectionService {
    private editorStateManager: EditorStateManager;
    private apiService: ApiService;
    private textProcessingService: TextProcessingService;
    private documentEditService: DocumentEditService;
    private operationLockService: OperationLockService;
    private diffHandlerService: DiffHandlerService;
    private diffManager: DiffManager | undefined;
    private _onDidChangeParagraphCorrections: vscode.EventEmitter<void>;
    
    // 记录当前正在处理的段落范围
    private processingRanges: Map<string, vscode.Range[]> = new Map();

    constructor(
        editorStateManager: EditorStateManager,
        apiService: ApiService,
        textProcessingService: TextProcessingService,
        documentEditService: DocumentEditService,
        operationLockService: OperationLockService,
        diffHandlerService: DiffHandlerService,
        onDidChangeParagraphCorrections: vscode.EventEmitter<void>
    ) {
        this.editorStateManager = editorStateManager;
        this.apiService = apiService;
        this.textProcessingService = textProcessingService;
        this.documentEditService = documentEditService;
        this.operationLockService = operationLockService;
        this.diffHandlerService = diffHandlerService;
        this._onDidChangeParagraphCorrections = onDidChangeParagraphCorrections;
    }

    /**
     * 设置DiffManager实例
     */
    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    /**
     * 获取文档的段落集合
     */
    private getDocumentParagraphs(editor: vscode.TextEditor): DocumentParagraphs | undefined {
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
     * 创建或获取文档段落集合
     */
    private ensureDocumentParagraphs(editor: vscode.TextEditor): DocumentParagraphs {
        let docParagraphs = this.getDocumentParagraphs(editor);
        
        if (!docParagraphs) {
            const document = editor.document;
            const documentContent = document.getText();
            docParagraphs = this.textProcessingService.createDocumentParagraphs(documentContent);
            this.setDocumentParagraphs(editor, docParagraphs);
        }
        
        return docParagraphs;
    }

    /**
     * 检查选中的文本是否与已处理的段落重叠
     */
    private isRangeOverlapping(editor: vscode.TextEditor, range: vscode.Range): boolean {
        const editorKey = editor.document.uri.toString();
        const processingRanges = this.processingRanges.get(editorKey) || [];
        
        for (const processingRange of processingRanges) {
            if (range.intersection(processingRange)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * 添加正在处理的范围
     */
    private addProcessingRange(editor: vscode.TextEditor, range: vscode.Range): void {
        const editorKey = editor.document.uri.toString();
        const processingRanges = this.processingRanges.get(editorKey) || [];
        processingRanges.push(range);
        this.processingRanges.set(editorKey, processingRanges);
    }

    /**
     * 移除正在处理的范围
     */
    private removeProcessingRange(editor: vscode.TextEditor, range: vscode.Range): void {
        const editorKey = editor.document.uri.toString();
        let processingRanges = this.processingRanges.get(editorKey) || [];
        
        processingRanges = processingRanges.filter(r => 
            !(r.start.line === range.start.line && 
              r.start.character === range.start.character && 
              r.end.line === range.end.line && 
              r.end.character === range.end.character)
        );
        
        this.processingRanges.set(editorKey, processingRanges);
    }    /**
     * 更新所有段落的位置信息和对应的diff信息
     */
    private updateAllParagraphsPosition(editor: vscode.TextEditor): void {
        const docParagraphs = this.getDocumentParagraphs(editor);
        if (!docParagraphs || docParagraphs.paragraphs.length === 0) {
            console.warn("[UpdatePosition] No document paragraphs found or empty.");
            return;
        }

        // 排序只在开始时进行一次，基于段落当前的 startLine
        docParagraphs.paragraphs.sort((a, b) => a.startLine - b.startLine);
        
        console.log(`[UpdatePosition] Starting update. Total paragraphs: ${docParagraphs.paragraphs.length}`);

        // 跟踪累积的行偏移量，用于diff信息更新
        let accumulatedLineDelta = 0;
        
        // 使用和全文纠错相同的简单增量更新逻辑
        for (let i = 0; i < docParagraphs.paragraphs.length; i++) {
            const paragraph = docParagraphs.paragraphs[i];
            
            // 计算此段落自身内容变化导致的行偏移
            let ownLineDeltaContribution = 0;
            if ((paragraph.status === ParagraphStatus.Pending || paragraph.status === ParagraphStatus.Accepted) && paragraph.correctedContent !== null) {
                const originalContentLines = paragraph.originalContent.split('\n').length;
                const correctedContentLines = paragraph.correctedContent.split('\n').length;
                ownLineDeltaContribution = correctedContentLines - originalContentLines;
            }
            
            // 如果此段落产生了行数变化，更新后续段落的位置
            if (ownLineDeltaContribution !== 0) {
                console.log(`[UpdatePosition] 段落 ${paragraph.id.substring(0,4)} 行数变化: ${ownLineDeltaContribution}行`);
                
                // 更新后续段落的起始行号（使用和全文纠错相同的逻辑）
                for (let j = i + 1; j < docParagraphs.paragraphs.length; j++) {
                    const nextParagraph = docParagraphs.paragraphs[j];
                    nextParagraph.startLineNumber = nextParagraph.startLineNumber + ownLineDeltaContribution;
                    nextParagraph.startLine = nextParagraph.startLine + ownLineDeltaContribution;
                    nextParagraph.endLine = nextParagraph.endLine + ownLineDeltaContribution;
                    console.log(`[UpdatePosition] 更新后续段落 ${nextParagraph.id.substring(0,4)} 起始行号为 ${nextParagraph.startLineNumber}`);
                }
                
                // 累积行偏移量
                accumulatedLineDelta += ownLineDeltaContribution;
            }
            
            // 更新当前段落的范围
            paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
            paragraph.endLine = paragraph.range.end.line;
        }
        
        // 在所有段落位置更新完成后，统一更新diff信息位置
        if (accumulatedLineDelta !== 0) {
            console.log(`[UpdatePosition] 总行数变化: ${accumulatedLineDelta}，更新diff信息位置`);
            this.updateAllDiffInfoPositions(editor);
        }
        
        // 保存更新后的段落集合
        this.setDocumentParagraphs(editor, docParagraphs);
        console.log(`[UpdatePosition] Finished update.`);
    }    /**
     * 更新段落对应的diff信息位置
     * @param paragraph 段落模型
     * @param editor 编辑器
     * @param lineDelta 行数变化
     */
    private updateDiffInfoForParagraph(paragraph: ParagraphModel, editor: vscode.TextEditor, lineDelta: number): void {
        if (!this.diffManager || lineDelta === 0) {
            return;
        }

        const changes = this.editorStateManager.getChanges(editor);
        
        // 修复关键逻辑：只更新在当前段落结束行之后的ChangeInfo位置
        // 这样避免了在多段落纠错时错误更新还未处理段落的diff信息
        const currentParagraphEndLine = paragraph.range.end.line;
        
        const changesToUpdate = changes.filter(change => {
            // 只更新起始行位置大于当前段落结束行的ChangeInfo
            // 这确保我们不会影响当前段落内或重叠的diff信息
            return change.range.start.line > currentParagraphEndLine;
        });
        
        console.log(`[UpdatePosition] 段落 ${paragraph.id.substring(0,4)} 结束于第${currentParagraphEndLine}行，行数变化 ${lineDelta}，需要更新 ${changesToUpdate.length} 个后续的ChangeInfo`);
        
        // 更新这些ChangeInfo的位置
        changesToUpdate.forEach((change, index) => {
            const oldRange = change.range;
            const newStartLine = Math.max(0, oldRange.start.line + lineDelta);
            const newEndLine = Math.max(0, oldRange.end.line + lineDelta);
            
            const newRange = new vscode.Range(
                new vscode.Position(newStartLine, oldRange.start.character),
                new vscode.Position(newEndLine, oldRange.end.character)
            );
            
            // 更新ChangeInfo的range
            change.range = newRange;
            
            console.log(`[UpdatePosition] ChangeInfo[${index}] 位置更新：L${oldRange.start.line}C${oldRange.start.character}-L${oldRange.end.line}C${oldRange.end.character} -> L${newStartLine}C${oldRange.start.character}-L${newEndLine}C${oldRange.end.character}`);
        });
        
        // 强制更新装饰以反映新的位置
        if (changesToUpdate.length > 0) {
            this.diffManager.updateDecorationsForEditor(editor);
        }
    }

    /**
     * 更新所有diff信息的位置
     * 在段落位置发生变化后，重新同步diff信息与段落位置
     */
    private updateAllDiffInfoPositions(editor: vscode.TextEditor): void {
        if (!this.diffManager) {
            return;
        }

        const docParagraphs = this.getDocumentParagraphs(editor);
        if (!docParagraphs) {
            return;
        }

        console.log(`[UpdateAllDiffInfo] 开始重建所有diff信息以确保位置正确`);

        // 1. 清除所有现有的diff信息
        this.editorStateManager.setChanges(editor, []);
        this.diffManager.clearDecorationsForEditor(editor);

        // 2. 重新为所有Pending状态的段落创建diff信息
        for (const paragraph of docParagraphs.paragraphs) {
            if (paragraph.status === ParagraphStatus.Pending && paragraph.correctedContent !== null) {
                console.log(`[UpdateAllDiffInfo] 重建段落 ${paragraph.id.substring(0,4)} 的diff信息`);
                
                // 使用段落当前的正确范围重新添加diff
                const rangeForDiff = this.calculateOriginalContentRange(paragraph);
                this.diffManager.addChange(
                    rangeForDiff,
                    paragraph.originalContent,
                    paragraph.correctedContent,
                    editor
                );
            }
        }

        // 3. 强制更新装饰
        this.diffManager.updateDecorationsForEditor(editor);
        console.log(`[UpdateAllDiffInfo] 完成重建所有diff信息`);
    }

    /**
     * 对选中的文本进行纠错
     */
    public async correctSelectedText(editor: vscode.TextEditor): Promise<void> {
        // 检查是否有选中的文本
        if (editor.selection.isEmpty) {
            vscode.window.showInformationMessage('请先选择要纠正的文本');
            return;
        }

        // 获取选中的文本范围
        const selection = editor.selection;
        // 保存初始选区，主要用于从 processingRanges 中移除和可能的错误回退
        const initialSelectionRange = new vscode.Range(selection.start, selection.end);
        const selectedText = editor.document.getText(initialSelectionRange);

        if (!selectedText.trim()) {
            vscode.window.showInformationMessage('选中的文本不能为空');
            return;
        }

        // 检查选中的文本是否与已处理的段落重叠
        if (this.isRangeOverlapping(editor, initialSelectionRange)) {
            vscode.window.showWarningMessage('所选文本与正在处理的段落重叠，请稍后再试');
            return;
        }

        // 尝试获取操作锁 - 使用段落特定的锁
        const paragraphId = uuidv4(); // 为新段落生成唯一ID
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'correctSelection', paragraphId);
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
            vscode.window.showWarningMessage('正在处理其他纠错操作，请稍后再试');
            return;
        }

        try {
            // 添加到正在处理的范围
            this.addProcessingRange(editor, initialSelectionRange);
            
            // 确保文档段落集合存在并获取它
            const docParagraphs = this.ensureDocumentParagraphs(editor);
            
            // 创建选中文本的段落模型
            // 注意：此时的 selectionRange (即 initialSelectionRange) 是基于调用此函数时的文档状态
            let paragraphModel = this.createParagraphModelFromSelection(editor, initialSelectionRange, selectedText);
            paragraphModel.id = paragraphId; // 使用生成的ID
            
            // 将新创建的段落模型添加到全局段落列表中
            // 这一步很重要，确保后续的 updateAllParagraphsPosition 能感知到这个新段落
            this.addParagraphToDocument(editor, paragraphModel);
            console.log(`[CorrectSelected] Paragraph ${paragraphId} model added to docParagraphs. Initial range:`, paragraphModel.range);
            
            // 调用API进行文本纠正
            try {
                console.log(`[CorrectSelected] API Input for ${paragraphId} (selectedText): >>>${selectedText}<<<`);
                const response = await this.apiService.correctText(selectedText);
                console.log(`[CorrectSelected] API Response for ${paragraphId} (raw):`, JSON.stringify(response));
                const correctedText = response.correctedText;
                console.log(`[CorrectSelected] API Output for ${paragraphId} (correctedText): >>>${correctedText}<<<`);
                
                // 当API结果返回时，其他操作（如P1的编辑）可能已经修改了文档
                // 并且可能已调用 updateAllParagraphsPosition 更新了本段落（P2）在 docParagraphs 中的位置信息

                // 重新从 docParagraphs 中获取本段落的最新状态模型
                const currentDocParagraphs = this.ensureDocumentParagraphs(editor); // 获取最新的段落集合
                let paragraphForEditOrDiff = currentDocParagraphs.paragraphs.find(p => p.id === paragraphId);

                if (!paragraphForEditOrDiff) {
                    console.error(`[CorrectSelected] ${paragraphId} CRITICAL: Could not find its own model in documentParagraphs after API call. Aborting.`);
                    vscode.window.showErrorMessage('无法应用选区更正：内部状态错误，请重试。');
                    // finally块会处理锁和processingRanges
                    return; 
                }

                // 安全检查：原始内容是否匹配
                if (paragraphForEditOrDiff.originalContent !== selectedText) {
                    console.error(`[CorrectSelected] ${paragraphId} CRITICAL: Content mismatch for model in documentParagraphs. Original in model: >>>${paragraphForEditOrDiff.originalContent}<<<, Expected: >>>${selectedText}<<< Aborting.`);
                    vscode.window.showErrorMessage('无法应用选区更正：内容不一致，请重试。');
                    return;
                }
                  if (correctedText && correctedText !== selectedText) {
                    // 使用当前段落的范围替换文本
                    const rangeToUseForReplacement = paragraphForEditOrDiff.range;
                    console.log(`[CorrectSelected] ${paragraphId} Using range for replacement:`, rangeToUseForReplacement);

                    // 步骤 1: 替换文本内容
                    await editor.edit(editBuilder => {
                        editBuilder.replace(rangeToUseForReplacement, correctedText);
                    });
                    console.log(`[CorrectSelected] ${paragraphId} Text replaced in editor.`);

                    // 更新段落模型的状态和纠正内容
                    paragraphForEditOrDiff.correctedContent = correctedText;
                    paragraphForEditOrDiff.status = ParagraphStatus.Pending;
                    
                    // 计算行数变化
                    const originalLines = selectedText.split('\n').length;
                    const correctedLines = correctedText.split('\n').length;
                    const lineDelta = correctedLines - originalLines;
                    console.log(`[CorrectSelected] ${paragraphId} line delta: ${lineDelta}`);
                    
                    // 步骤 2: 更新当前段落的范围
                    paragraphForEditOrDiff.range = this.textProcessingService.updateParagraphRange(paragraphForEditOrDiff);
                    console.log(`[CorrectSelected] ${paragraphId} range updated after applying corrected text. New range:`, paragraphForEditOrDiff.range);                      // 步骤 3: 如果行数发生变化，使用简单的增量更新逻辑更新后续段落位置
                    if (lineDelta !== 0) {
                        console.log(`[CorrectSelected] ${paragraphId} caused line delta, updating subsequent paragraphs.`);
                        
                        // 找到当前段落在段落列表中的索引
                        const currentIndex = currentDocParagraphs.paragraphs.findIndex(p => p.id === paragraphId);
                        if (currentIndex !== -1 && currentIndex < currentDocParagraphs.paragraphs.length - 1) {                            // 更新后续段落的位置信息（使用和全文纠错相同的逻辑）
                            for (let j = currentIndex + 1; j < currentDocParagraphs.paragraphs.length; j++) {
                                const nextParagraph = currentDocParagraphs.paragraphs[j];
                                nextParagraph.startLineNumber = nextParagraph.startLineNumber + lineDelta;
                                nextParagraph.startLine = nextParagraph.startLine + lineDelta;
                                nextParagraph.endLine = nextParagraph.endLine + lineDelta;
                                
                                // 更新段落的范围
                                nextParagraph.range = this.textProcessingService.updateParagraphRange(nextParagraph);
                                
                                console.log(`[CorrectSelected] 更新后续段落 ${nextParagraph.id.substring(0,4)} 起始行号为 ${nextParagraph.startLineNumber}`);
                            }
                            
                            // 关键修复：更新后续段落的diff信息位置
                            this.updateDiffInfoForParagraph(paragraphForEditOrDiff, editor, lineDelta);
                        }
                    }
                    
                    // 保存更新后的段落集合
                    this.setDocumentParagraphs(editor, currentDocParagraphs); 
                    
                    // 步骤 4: 应用差异显示
                    this.applyDiffToEditor(editor, paragraphForEditOrDiff);
                    
                    // 所有编辑和diff应用完成后，设置状态为 Pending (待审核)
                    paragraphForEditOrDiff.status = ParagraphStatus.Pending;
                    console.log(`[CorrectSelected] ${paragraphId} status set to Pending for review.`);
                    
                    this._onDidChangeParagraphCorrections.fire();
                } else {
                    // 文本无需纠正
                    paragraphForEditOrDiff.status = ParagraphStatus.Rejected; // 更新状态
                    this.setDocumentParagraphs(editor, currentDocParagraphs); // 保存状态更改
                    console.log(`[CorrectSelected] ${paragraphId} text needs no correction. Status set to Rejected.`);
                    vscode.window.showInformationMessage('文本无需纠正');
                    this._onDidChangeParagraphCorrections.fire();
                }
            } catch (error) { // API 调用或后续处理的错误
                console.error(`[CorrectSelected] Error during ${paragraphId} correction API call or processing:`, error);
                vscode.window.showErrorMessage(`纠错失败: ${error instanceof Error ? error.message : String(error)}`);
                
                // 更新段落状态为错误
                const pModelInDoc = this.getDocumentParagraphs(editor)?.paragraphs.find(p => p.id === paragraphId);
                if (pModelInDoc) {
                    pModelInDoc.status = ParagraphStatus.Error;
                    pModelInDoc.error = error instanceof Error ? error.message : String(error);
                    this.setDocumentParagraphs(editor, this.ensureDocumentParagraphs(editor)); 
                }
                this._onDidChangeParagraphCorrections.fire();
            }
        } finally {
            // 从正在处理的范围中移除 (使用最初的 selectionRange)
            this.removeProcessingRange(editor, initialSelectionRange);
            this.operationLockService.releaseOperationLock(lockKey);
            console.log(`[CorrectSelected] ${paragraphId} processing finished. Lock released.`);
        }
    }

    /**
     * 根据选择创建段落模型
     */
    private createParagraphModelFromSelection(
        editor: vscode.TextEditor,
        selectionRange: vscode.Range,
        selectedText: string
    ): ParagraphModel {        return {
            id: uuidv4(), // 这个id会被 correctSelectedText 中的 paragraphId 覆盖
            originalContent: selectedText,
            correctedContent: null,
            startLine: selectionRange.start.line,
            startLineNumber: selectionRange.start.line, 
            endLine: selectionRange.end.line,
            range: new vscode.Range(selectionRange.start, selectionRange.end), // 使用传入的精确范围
            status: ParagraphStatus.Pending, // 初始状态设为Pending，在API调用完成后会更新状态
            error: undefined,
            trailingEmptyLines: 0 
        };
    }    /**
     * 将段落模型添加到文档段落集合
     */
    private addParagraphToDocument(editor: vscode.TextEditor, paragraph: ParagraphModel): void {
        const docParagraphs = this.ensureDocumentParagraphs(editor);
        
        // 简单地添加段落到集合中
        docParagraphs.paragraphs.push(paragraph);
        
        // 根据段落的起始行排序
        docParagraphs.paragraphs.sort((a, b) => a.startLine - b.startLine);
        
        // 保存更新后的段落集合
        this.setDocumentParagraphs(editor, docParagraphs);
        
        console.log(`[AddParagraph] 段落 ${paragraph.id.substring(0,4)} 已添加到文档段落集合`);
    }

    /**
     * 在编辑器中应用差异
     */
    private applyDiffToEditor(editor: vscode.TextEditor, paragraph: ParagraphModel): void {
        if (!this.diffManager || paragraph.correctedContent === null) {
            return;
        }
        
        // 注意：不在这里重新计算段落范围，因为调用者已经确保了 paragraph.range 是正确的
        // 特别是在多段落修改的场景下，段落范围已经通过 updateAllParagraphsPosition 正确更新了
        
        const originalContentForDiff = paragraph.originalContent; // O1
        const correctedContentForDiff = paragraph.correctedContent; // C1
        
        // 计算原始内容在当前文档中的range (这是DiffManager需要的)
        const rangeForDiff = this.calculateOriginalContentRange(paragraph);

        console.log(`[ApplyDiffDebug] Original Content for Diff (P.ID: ${paragraph.id.substring(0,4)}): >>>${originalContentForDiff.substring(0,30)}...<<<`);
        console.log(`[ApplyDiffDebug] Corrected Content for Diff (P.ID: ${paragraph.id.substring(0,4)}): >>>${correctedContentForDiff.substring(0,30)}...<<<`);
        console.log(`[ApplyDiffDebug] Range for Diff (P.ID: ${paragraph.id.substring(0,4)}): Start(${rangeForDiff.start.line}, ${rangeForDiff.start.character}), End(${rangeForDiff.end.line}, ${rangeForDiff.end.character})`);
        
        let textInEditorAtRange = "";
        try {
            textInEditorAtRange = editor.document.getText(rangeForDiff);
            console.log(`[ApplyDiffDebug] Text in Editor at RangeForDiff (P.ID: ${paragraph.id.substring(0,4)}): >>>${textInEditorAtRange.substring(0,30)}...<<<`);
            console.log(`[ApplyDiffDebug] Text length: ${textInEditorAtRange.length}, Range valid: ${!rangeForDiff.isEmpty}, Document line count: ${editor.document.lineCount}`);
        } catch (e) {
            console.error(`[ApplyDiffDebug] Error getting text from editor at range (P.ID: ${paragraph.id.substring(0,4)}):`, e);
        }

        // 计算并记录行数变化
        const originalLines = paragraph.originalContent.split('\n').length;
        const correctedLines = paragraph.correctedContent.split('\n').length;
        const lineDelta = correctedLines - originalLines;
        
        console.log(`[ApplyDiff] P.ID: ${paragraph.id.substring(0,4)} adding diff, Range: ${paragraph.range.start.line}-${paragraph.range.end.line}, LineDelta: ${lineDelta}`);
        
        // 使用DiffManager添加变更
        console.log(`[ApplyDiffDebug] Preparing to addChange for P.ID: ${paragraph.id.substring(0,4)}. Range: L${rangeForDiff.start.line}C${rangeForDiff.start.character}-L${rangeForDiff.end.line}C${rangeForDiff.end.character}, Original: "${originalContentForDiff.substring(0,30)}...", Corrected: "${correctedContentForDiff.substring(0,30)}..."`);
        this.diffManager.addChange(
            rangeForDiff, // 使用我们获取并验证的 rangeForDiff
            originalContentForDiff, // O1
            correctedContentForDiff, // C1
            editor
        );
        
        // 检查addChange后EditorStateManager中的changes数组
        const changesAfterAdd = this.editorStateManager.getChanges(editor);
        console.log(`[ApplyDiffDebug] After addChange for P.ID: ${paragraph.id.substring(0,4)}, EditorStateManager has ${changesAfterAdd.length} ChangeInfos`);
        if (changesAfterAdd.length > 0) {
            const lastChange = changesAfterAdd[changesAfterAdd.length - 1];
            console.log(`[ApplyDiffDebug] Last ChangeInfo in EditorStateManager - Range: L${lastChange.range.start.line}C${lastChange.range.start.character}-L${lastChange.range.end.line}C${lastChange.range.end.character}, Original: "${lastChange.original.substring(0,30)}...", Corrected: "${lastChange.corrected.substring(0,30)}..."`);
        }
        
        // 更新装饰
        this.diffManager.updateDecorationsForEditor(editor);
        
        // 强制再次更新装饰，确保显示正确
        setTimeout(() => {
            if (this.diffManager) {
                this.diffManager.updateDecorationsForEditor(editor);
            }
        }, 50);
    }

    /**
     * 计算原始内容在当前文档中的range
     * 关键理解：在多段落修改的情况下，当前段落的原始内容已经被替换为纠正后的内容，
     * 所以DiffManager需要显示的diff应该基于当前纠正后内容在文档中的实际位置。
     * 换句话说，diff显示的是"在当前这个位置，原始内容是什么，现在显示的纠正后内容是什么"。
     */
    private calculateOriginalContentRange(paragraph: ParagraphModel): vscode.Range {
        // 关键修复：正确计算原始内容在当前文档中的位置
        // 
        // 核心理解：
        // - 对于Pending状态段落，paragraph.range 是纠正后内容在文档中的实际范围
        // - DiffManager需要的是：在这个位置，我们要告诉用户"原始内容是什么，现在显示的纠正内容是什么"
        // - 关键洞察：diff应该基于纠正内容的实际占用范围，因为那是用户在编辑器中看到的内容
        
        if (paragraph.status === ParagraphStatus.Pending && paragraph.correctedContent !== null) {
            console.log(`[CalculateOriginalRange] P.ID: ${paragraph.id.substring(0,4)} Pending段落，计算原始内容范围:`);
            
            // 重要修复：对于Pending段落，应该使用纠正内容的实际范围
            // 因为DiffManager需要高亮的是用户当前在编辑器中看到的内容位置
            // 这样diff会显示："在编辑器这个位置的内容，原始是X，现在显示的是Y"
            
            const correctedRange = paragraph.range;
            
            console.log(`[CalculateOriginalRange] - 使用纠正内容的实际范围作为原始内容范围`);
            console.log(`[CalculateOriginalRange] - 纠正内容范围: Start(${correctedRange.start.line}, ${correctedRange.start.character}), End(${correctedRange.end.line}, ${correctedRange.end.character})`);
            console.log(`[CalculateOriginalRange] - 原始内容长度: ${paragraph.originalContent.length}, 纠正内容长度: ${paragraph.correctedContent.length}`);
            
            return correctedRange;
        } else {
            // 对于非Pending状态的段落，直接使用paragraph.range
            console.log(`[CalculateOriginalRange] P.ID: ${paragraph.id.substring(0,4)} 非Pending段落，使用paragraph.range`);
            return paragraph.range;
        }
    }

    /**
     * 检查是否有选中的文本
     */
    public hasSelection(editor: vscode.TextEditor | undefined): boolean {
        return editor !== undefined && !editor.selection.isEmpty;
    }

    /**
     * 获取当前选中文本的范围
     */
    public getSelectionRange(editor: vscode.TextEditor): vscode.Range | undefined {
        if (!editor || editor.selection.isEmpty) {
            return undefined;
        }
        return new vscode.Range(editor.selection.start, editor.selection.end);
    }

    /**
     * 接受段落修改
     */
    public async acceptParagraph(paragraphId: string, editor: vscode.TextEditor): Promise<void> {
        // 获取ParagraphActionService实例
        const paragraphActionService = this.getParagraphActionService();
        if (!paragraphActionService) {
            console.error('无法获取ParagraphActionService实例');
            return;
        }
        
        // 使用ParagraphActionService接受段落
        await paragraphActionService.acceptParagraph(paragraphId, editor);
        
        // 更新所有段落的位置信息
        this.updateAllParagraphsPosition(editor);
    }
    
    /**
     * 拒绝段落修改
     */
    public async rejectParagraph(paragraphId: string, editor: vscode.TextEditor): Promise<void> {
        console.log(`[RejectParagraphDebug] Starting rejection for P.ID: ${paragraphId.substring(0,4)}`);
        
        const docParagraphs = this.getDocumentParagraphs(editor);
        if (!docParagraphs) {
            console.warn(`[RejectParagraph] No document paragraphs found for editor: ${editor.document.uri}`);
            return;
        }

        const paragraph = docParagraphs.paragraphs.find(p => p.id === paragraphId);
        if (!paragraph) {
            console.warn(`[RejectParagraph] Paragraph with ID ${paragraphId} not found.`);
            return;
        }
        
        console.log(`[RejectParagraphDebug] Found paragraph with ID ${paragraphId.substring(0,4)}, status: ${paragraph.status}, hasCorrectContent: ${paragraph.correctedContent !== null}`);
        
        // 检查锁，如果纠错服务正在修改此段落，则不允许拒绝
        const lockKey = this.operationLockService.getOperationLockKey(editor, 'correctSelection', paragraphId);
        // 尝试获取与 correctSelectedText 操作相同的锁，以检查它是否正在处理此段落
        if (!this.operationLockService.tryAcquireOperationLock(lockKey)) {
            // 如果获取锁失败，说明 'correctSelection' 正在处理此段落
            vscode.window.showWarningMessage("该段落的纠错操作正在处理中，请稍后再试。");
            return;
        } else {
            // 如果获取成功，说明没有正在进行的 'correctSelection' 操作，立即释放该锁
            this.operationLockService.releaseOperationLock(lockKey);
        }
        
        // 记录原始的 startLine 和 endLine，用于可能的还原和行号调整
        const originalStartLine = paragraph.startLine;
        const originalEndLine = paragraph.endLine; // 这是基于 correctedContent 的 endLine
        const originalContentLines = paragraph.originalContent.split('\n').length;
        const correctedContentLines = paragraph.correctedContent ? paragraph.correctedContent.split('\n').length : originalContentLines;

        // 关键：Diff的移除和文本的还原都应该作用在 paragraph.range 上，
        // 这个 range 是基于 correctedContent 和它的 startLine 计算的。
        const rangeToModify = paragraph.range;

        if (!rangeToModify) {
            console.error(`[RejectParagraph] Paragraph ${paragraphId} has no range. Cannot reject.`);
            vscode.window.showErrorMessage("无法拒绝修改：段落范围丢失。");
            return;
        }        try {
            // 保存清理diff所需的信息（在修改段落状态之前）
            const rangeForDiffCleanup = paragraph.range;
            const originalContentForDiffCleanup = paragraph.originalContent;
            const correctedContentForDiffCleanup = paragraph.correctedContent;
            
            console.log(`[RejectParagraphDebug] 准备清理diff信息。Range: L${rangeForDiffCleanup.start.line}C${rangeForDiffCleanup.start.character}-L${rangeForDiffCleanup.end.line}C${rangeForDiffCleanup.end.character}, Original: "${originalContentForDiffCleanup}", Corrected: "${correctedContentForDiffCleanup}"`);
            
            // 步骤1：直接从EditorStateManager中移除该段落的差异高亮
            const allChanges = this.editorStateManager.getChanges(editor);
            console.log(`[RejectParagraphDebug] Found ${allChanges.length} total ChangeInfos in EditorStateManager for editor: ${editor.document.uri.toString()}`);
            
            if (correctedContentForDiffCleanup === null) { 
                console.warn(`[RejectParagraph] Paragraph ${paragraph.id} has no corrected content, so no ChangeInfo to remove for diff.`);
            } else {
                const remainingChanges = allChanges.filter((change, index) => {
                    const isRangeEqual = change.range.isEqual(rangeForDiffCleanup);
                    const isOriginalEqual = change.original === originalContentForDiffCleanup;
                    const isCorrectedEqual = change.corrected === correctedContentForDiffCleanup;
                    const isMatch = isRangeEqual && isOriginalEqual && isCorrectedEqual;

                    console.log(`[RejectParagraphDebug] Checking ChangeInfo[${index}]: ` +
                        `Range: L${change.range.start.line}C${change.range.start.character}-L${change.range.end.line}C${change.range.end.character} (match=${isRangeEqual}), ` +
                        `Original: "${change.original.substring(0,30)}..." (match=${isOriginalEqual}), ` +
                        `Corrected: "${change.corrected.substring(0,30)}..." (match=${isCorrectedEqual}). Overall match: ${isMatch}`);
    
                    if (isMatch) {
                        console.log(`[RejectParagraph] Removing ChangeInfo for P.ID: ${paragraph.id.substring(0,4)} from EditorStateManager. Matched ChangeInfo[${index}].`);
                        return false; // 过滤掉这个 change
                    }
                    return true; // Keep this change
                });

                if (allChanges.length !== remainingChanges.length) {
                    this.editorStateManager.setChanges(editor, remainingChanges);
                    console.log(`[RejectParagraph] Successfully removed ChangeInfo. Remaining changes: ${remainingChanges.length}`);
                } else {
                    console.warn(`[RejectParagraph] Did not find matching ChangeInfo in EditorStateManager for paragraph ${paragraph.id} to remove.`);
                }
            }
            
            // 步骤2：将编辑器的文本还原为原始内容
            await editor.edit(editBuilder => {
                editBuilder.replace(rangeToModify, paragraph.originalContent);
            });

            // 步骤3：更新段落模型状态
            paragraph.status = ParagraphStatus.Rejected;
            paragraph.correctedContent = null; // 清空纠正内容

            // 步骤4：更新段落的范围以反映原始内容
            paragraph.range = this.textProcessingService.updateParagraphRange(paragraph);
            
            // 步骤5：如果行数因还原而发生变化，则更新所有段落的位置
            const lineDelta = originalContentLines - correctedContentLines; // 原始行数 - 纠正后行数
            if (lineDelta !== 0) {
                console.log(`[RejectParagraph] Paragraph ${paragraphId} rejection caused line delta: ${lineDelta}. Updating positions.`);
                this.updateAllParagraphsPosition(editor);
            }
            
            // 步骤6：强制更新装饰以反映变化
            if (this.diffManager) {
                this.diffManager.updateDecorationsForEditor(editor);
            }
            
            // 保存更新后的段落集合
            this.setDocumentParagraphs(editor, docParagraphs);
            this._onDidChangeParagraphCorrections.fire(); // 通知UI更新

        } catch (error) {
            console.error(`[RejectParagraph] Error rejecting paragraph ${paragraphId}:`, error);
            vscode.window.showErrorMessage(`拒绝段落 ${paragraphId} 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    /**
     * 获取ParagraphActionService实例
     * 通过CorrectionService获取
     */
    private getParagraphActionService(): any {
        // 尝试通过全局变量获取CorrectionService
        const vscodeExtensions = vscode.extensions.all;
        for (const ext of vscodeExtensions) {
            if (ext.id === 'li-aolong.text-correction') {
                const correctionService = (ext.exports as any).correctionService;
                if (correctionService && correctionService.paragraphActionService) {
                    return correctionService.paragraphActionService;
                }
            }
        }
        
        return null;
    }
}
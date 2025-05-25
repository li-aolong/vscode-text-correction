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
    originalText: string; // 不包含换行符的纯文本，用于API调用
    correctedText: string | null; //  null if no correction or API error
    range: vscode.Range;
    status: ParagraphStatus;
    originalLines: string[]; // 保存原始行结构，用于拒绝时恢复
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

    /**
     * 只更新仍处于Pending状态的段落，保留已经被用户操作过的段落状态
     */
    public updatePendingParagraphsStatus(status: ParagraphStatus): void {
        console.log(`UPDATE_PENDING_PARAGRAPHS_STATUS: ${status}`);

        let updatedCount = 0;
        this.paragraphCorrections.forEach(p => {
            if (p.status === ParagraphStatus.Pending) {
                console.log(`  UPDATING paragraph ${p.id}: Pending -> ${status}`);
                p.status = status;
                updatedCount++;
            } else {
                console.log(`  KEEPING paragraph ${p.id}: ${p.status} (already processed)`);
            }
        });

        console.log(`UPDATED_${updatedCount}_PARAGRAPHS, KEPT_${this.paragraphCorrections.length - updatedCount}_EXISTING`);
        this._onDidChangeParagraphCorrections.fire();
    }

    /**
     * 智能全部接受：只接受仍处于Pending状态的段落
     */
    public async acceptAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        console.log(`\n=== ACCEPT_ALL_PENDING_PARAGRAPHS ===`);

        const pendingParagraphs = this.paragraphCorrections.filter(p => p.status === ParagraphStatus.Pending);
        console.log(`FOUND_${pendingParagraphs.length}_PENDING_PARAGRAPHS`);

        for (const paragraph of pendingParagraphs) {
            console.log(`ACCEPTING_PARAGRAPH: ${paragraph.id}`);
            await this.acceptParagraph(paragraph.id, editor);
        }

        // 清理DiffManager中剩余的装饰
        if (this.diffManager) {
            (this.diffManager as any).clearDecorations?.();
        }

        console.log(`ACCEPT_ALL_PENDING_COMPLETED`);
    }

    /**
     * 智能全部拒绝：只拒绝仍处于Pending状态的段落
     */
    public async rejectAllPendingParagraphs(editor: vscode.TextEditor): Promise<void> {
        console.log(`\n=== REJECT_ALL_PENDING_PARAGRAPHS ===`);

        const pendingParagraphs = this.paragraphCorrections.filter(p => p.status === ParagraphStatus.Pending);
        console.log(`FOUND_${pendingParagraphs.length}_PENDING_PARAGRAPHS`);

        for (const paragraph of pendingParagraphs) {
            console.log(`REJECTING_PARAGRAPH: ${paragraph.id}`);
            await this.rejectParagraph(paragraph.id, editor);
        }

        // 清理DiffManager中剩余的装饰
        if (this.diffManager) {
            (this.diffManager as any).clearDecorations?.();
        }

        console.log(`REJECT_ALL_PENDING_COMPLETED`);
    }

    public async correctFullText(
        editor: vscode.TextEditor,
        progressCallback?: (current: number, total: number) => void
    ): Promise<void> {
        const errors = this.configManager.validateConfig();

        if (errors.length > 0) {
            throw new Error(`配置错误: ${errors.join(', ')}`);
        }

        this.clearAllCorrectionsState(); // 开始新的纠错前，清空旧状态

        this.originalDocumentContent = editor.document.getText();

        console.log(`\n=== INITIAL_EDITOR_STATE ===`);
        this.printEditorContent(editor, "INITIAL");

        const paragraphsInfo = this.splitIntoParagraphs(this.originalDocumentContent);

        // 使用更简单可靠的方法：逐个处理段落，每次都重新获取当前文档状态
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
                    console.log(`\n=== 段落 ${i + 1} ===`);
                    console.log(`INPUT: "${paraInfo.content}"`);

                    const apiCorrectedText = await this.correctParagraphAPI(paraInfo.content);

                    console.log(`OUTPUT: "${apiCorrectedText}"`);
                    console.log(`CHANGED: ${apiCorrectedText !== paraInfo.content}`);

                    // 调试信息
                    console.log(`DEBUG_INPUT_BYTES: [${Array.from(paraInfo.content).map(c => c.charCodeAt(0)).join(',')}]`);
                    console.log(`DEBUG_OUTPUT_BYTES: [${Array.from(apiCorrectedText).map(c => c.charCodeAt(0)).join(',')}]`);

                    // 重新获取当前段落在文档中的实际位置
                    const currentRange = this.findParagraphInCurrentDocument(editor, paraInfo.content, i);
                    console.log(`RANGE_FOUND: L${currentRange.start.line + 1}-L${currentRange.end.line + 1}`);
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;

                    // 获取当前实际的行结构（基于找到的位置）
                    const originalLines = [];
                    for (let lineIndex = currentRange.start.line; lineIndex <= currentRange.end.line; lineIndex++) {
                        originalLines.push(editor.document.lineAt(lineIndex).text);
                    }
                    const actualContent = originalLines.join('\n');
                    console.log(`ACTUAL_DOC_CONTENT: "${actualContent}"`);

                    if (apiCorrectedText !== paraInfo.content) {
                        console.log(`APPLYING_CHANGE: L${currentRange.start.line + 1}-L${currentRange.end.line + 1}`);

                        // 1. 应用修改到编辑器
                        await this.applyCorrectionToEditor(editor, {
                            content: paraInfo.content,
                            startLine: currentRange.start.line,
                            endLine: currentRange.end.line
                        }, apiCorrectedText);

                        // 2. 重新计算修改后的range（基于新的文档状态）
                        const newRange = this.calculateRangeAfterReplacement(currentRange, apiCorrectedText);
                        console.log(`NEW_RANGE: L${newRange.start.line + 1}-L${newRange.end.line + 1}`);

                        // 3. 创建 ParagraphCorrection 对象
                        const correctionEntry: ParagraphCorrection = {
                            id: paragraphId,
                            originalText: paraInfo.content,
                            correctedText: apiCorrectedText,
                            range: newRange,
                            status: ParagraphStatus.Pending,
                            originalLines: originalLines,
                        };
                        this.paragraphCorrections.push(correctionEntry);

                        // 4. 告诉 DiffManager 添加差异高亮
                        if (this.diffManager) {
                            this.diffManager.addChange(newRange, paraInfo.content, apiCorrectedText);
                        }

                        // 5. 立即更新后续段落的range（因为当前段落的行数可能发生了变化）
                        this.updateSubsequentParagraphRanges(correctionEntry, editor);

                        console.log(`PARAGRAPH_${i + 1}_DONE: CHANGED`);

                        // 6. 打印修改后的编辑器状态
                        this.printEditorContent(editor, `AFTER_PARAGRAPH_${i + 1}`);
                    } else {
                        // 文本没有变化，说明原文正确，不需要任何操作
                        console.log(`PARAGRAPH_${i + 1}_DONE: CORRECT_NO_ACTION_NEEDED`);
                        // 注意：不添加到 paragraphCorrections 数组中，这样就不会显示接受/拒绝按钮
                    }

                } catch (error) {
                    vscode.window.showErrorMessage(`段落 ${i + 1} 纠错失败: ${error instanceof Error ? error.message : String(error)}`);
                    // 记录失败的段落信息
                    const currentRange = this.findParagraphInCurrentDocument(editor, paraInfo.content, i);
                    const paragraphId = `${paraInfo.startLine}-${paraInfo.endLine}`;

                    // 获取原始行结构（即使API失败也需要保存）
                    const originalLines = [];
                    for (let lineIndex = currentRange.start.line; lineIndex <= currentRange.end.line; lineIndex++) {
                        originalLines.push(editor.document.lineAt(lineIndex).text);
                    }

                    this.paragraphCorrections.push({
                        id: paragraphId,
                        originalText: paraInfo.content,
                        correctedText: null, // API error
                        range: currentRange,
                        status: ParagraphStatus.Pending, // Or a new status like 'ApiError'
                        originalLines: originalLines,
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

        console.log(`SPLIT_PARAGRAPHS_DEBUG:`, paragraphs.map(p => ({
            content: p.content,
            lines: `L${p.startLine + 1}-L${p.endLine + 1}`,
            bytes: Array.from(p.content).map(c => c.charCodeAt(0))
        })));

        return paragraphs;
    }

    // 重命名以区分概念上的段落和API调用
    private async correctParagraphAPI(text: string): Promise<string> {
        const config = this.configManager.getConfig();

        // 构建发送给API的完整prompt
        const fullPrompt = config.prompt.replace('{user_content}', text);

        console.log(`API_SEND: "${text}"`);

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
            console.log(`API_RAW_RESPONSE: "${responseContent}"`);

            try {
                const jsonContent = this.extractJsonFromResponse(responseContent);
                const correctionResult: CorrectionResponse = JSON.parse(jsonContent);

                console.log(`API_PARSED_RESULT: ${correctionResult.result}`);
                console.log(`API_CORRECTED_TEXT: "${correctionResult.corrected_text}"`);

                // 如果没有错误（result为true），返回原文本
                if (correctionResult.result === true || correctionResult.corrected_text === null) {
                    console.log(`API_FINAL_RETURN: "${text}" (no change)`);
                    return text;
                }

                // 如果有错误，返回纠正后的文本
                const finalResult = correctionResult.corrected_text || text;
                console.log(`API_FINAL_RETURN: "${finalResult}" (changed)`);
                return finalResult;

            } catch (parseError) {
                console.error(`API_PARSE_ERROR:`, parseError instanceof Error ? parseError.message : String(parseError));
                console.error(`API_RAW_CONTENT:`, responseContent);
                console.log(`API_FINAL_RETURN: "${text}" (parse failed)`);
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

    // 修改：此方法仅应用文本到编辑器，不直接与DiffManager交互
    private async applyCorrectionToEditor(
        editor: vscode.TextEditor,
        paragraph: { content: string, startLine: number, endLine: number },
        correctedText: string
    ): Promise<void> {
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

        await editor.edit(editBuilder => {
            editBuilder.replace(range, finalText);
        });
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

        console.log(`FIND_PARAGRAPH_${paragraphIndex}_DEBUG:`);
        console.log(`  TARGET_CONTENT: "${normalizedTargetContent}"`);
        console.log(`  TARGET_LINES:`, targetLines);
        console.log(`  DOC_TOTAL_LINES: ${lines.length}`);

        // 如果是第一个段落，从文档开头开始查找
        let searchStartLine = 0;

        // 对于后续段落，从前一个段落的结束位置开始查找
        if (paragraphIndex > 0 && this.paragraphCorrections.length > 0) {
            const lastProcessedParagraph = this.paragraphCorrections[this.paragraphCorrections.length - 1];
            searchStartLine = lastProcessedParagraph.range.end.line + 1;
            console.log(`  SEARCH_START_LINE: ${searchStartLine + 1} (after previous paragraph)`);
        } else {
            console.log(`  SEARCH_START_LINE: ${searchStartLine + 1} (first paragraph)`);
        }

        // 从搜索起始位置开始查找匹配的段落
        for (let startLine = searchStartLine; startLine < lines.length; startLine++) {
            // 跳过空行
            if (lines[startLine].trim() === '') continue;

            console.log(`  CHECKING_LINE_${startLine + 1}: "${lines[startLine]}"`);

            // 检查是否匹配第一行
            if (lines[startLine] === targetLines[0]) {
                console.log(`  FIRST_LINE_MATCH at L${startLine + 1}`);

                // 检查是否完全匹配整个段落
                let matches = true;
                let endLine = startLine;

                for (let i = 0; i < targetLines.length && startLine + i < lines.length; i++) {
                    console.log(`    COMPARE L${startLine + i + 1}: "${lines[startLine + i]}" vs "${targetLines[i]}"`);
                    if (lines[startLine + i] !== targetLines[i]) {
                        matches = false;
                        console.log(`    MISMATCH at line ${i}`);
                        break;
                    }
                    endLine = startLine + i;
                }

                if (matches) {
                    console.log(`  EXACT_MATCH_FOUND: L${startLine + 1}-L${endLine + 1}`);
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

        console.log(`CALCULATE_NEW_RANGE_DEBUG:`);
        console.log(`  ORIGINAL_RANGE: L${originalRange.start.line + 1}-L${originalRange.end.line + 1}`);
        console.log(`  NEW_TEXT_LINES: ${newLines.length}`);
        console.log(`  NEW_TEXT_CONTENT: "${newText}"`);
        console.log(`  CALCULATED_NEW_RANGE: L${startPos.line + 1}-L${newEndLine + 1}`);

        return new vscode.Range(
            startPos,
            new vscode.Position(newEndLine, newEndChar)
        );
    }

    /**
     * 更新后续段落的range，当某个段落被修改后调用
     */
    private updateSubsequentParagraphRanges(changedParagraph: ParagraphCorrection, editor: vscode.TextEditor): void {
        const changedIndex = this.paragraphCorrections.indexOf(changedParagraph);
        if (changedIndex === -1) return;

        console.log(`UPDATE_SUBSEQUENT_RANGES: starting from paragraph ${changedIndex + 1}`);

        // 重新计算所有段落的位置，使用更智能的方法
        this.recalculateAllParagraphRanges(editor);

        console.log(`UPDATE_SUBSEQUENT_RANGES_COMPLETED`);
    }

    /**
     * 重新计算所有段落的range位置
     * 这个方法会重新扫描整个文档来定位每个段落
     */
    private recalculateAllParagraphRanges(editor: vscode.TextEditor): void {
        console.log(`RECALCULATE_ALL_RANGES: starting`);

        const document = editor.document;
        const normalizedDocText = document.getText().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const docLines = normalizedDocText.split('\n');

        console.log(`  CURRENT_DOC_LINES: ${docLines.length}`);
        docLines.forEach((line, index) => {
            console.log(`    L${index + 1}: "${line}"`);
        });

        // 为每个段落重新查找位置
        let currentSearchLine = 0;

        for (let i = 0; i < this.paragraphCorrections.length; i++) {
            const paragraph = this.paragraphCorrections[i];

            // 跳过已拒绝的段落，它们不需要重新计算范围
            if (paragraph.status === ParagraphStatus.Rejected) {
                console.log(`  RECALC_PARAGRAPH_${i}: SKIPPED (already rejected)`);
                continue;
            }

            // 对于未拒绝的段落，我们需要在文档中查找纠正后的文本
            const targetText = paragraph.correctedText || paragraph.originalText;
            const normalizedTargetText = targetText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const targetLines = normalizedTargetText.split('\n');

            console.log(`  RECALC_PARAGRAPH_${i}:`);
            console.log(`    STATUS: ${paragraph.status}`);
            console.log(`    SEARCHING_FOR_CORRECTED_TEXT: "${normalizedTargetText}"`);
            console.log(`    TARGET_LINES:`, targetLines);
            console.log(`    SEARCH_FROM: L${currentSearchLine + 1}`);

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

                        console.log(`    FOUND_CORRECTED_TEXT_AT: L${startLine + 1}-L${endLine + 1}`);
                        console.log(`    OLD_RANGE: L${paragraph.range.start.line + 1}-L${paragraph.range.end.line + 1}`);
                        console.log(`    NEW_PRECISE_RANGE: L${newRange.start.line + 1}:${newRange.start.character}-L${newRange.end.line + 1}:${newRange.end.character}`);

                        paragraph.range = newRange;
                        currentSearchLine = endLine + 1; // 下次从这个段落后面开始搜索
                        found = true;

                        // 同时更新DiffManager中对应的ChangeInfo
                        if (this.diffManager) {
                            const changes = (this.diffManager as any).changes as ChangeInfo[];
                            if (changes) {
                                const changeInfo = changes.find(change =>
                                    change.original === paragraph.originalText &&
                                    change.corrected === paragraph.correctedText
                                );
                                if (changeInfo) {
                                    console.log(`    UPDATED_DIFFMANAGER: L${newRange.start.line + 1}:${newRange.start.character}-L${newRange.end.line + 1}:${newRange.end.character}`);
                                    changeInfo.range = newRange;
                                }
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

        console.log(`RECALCULATE_ALL_RANGES_COMPLETED`);
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
        console.log(`CALCULATE_PRECISE_RANGE: L${startLine + 1}-L${endLine + 1}`);

        // 对于单行段落，计算精确的字符范围
        if (targetLines.length === 1) {
            const lineText = document.lineAt(startLine).text;
            const targetText = targetLines[0];

            // 在行内查找目标文本的精确位置
            const startChar = lineText.indexOf(targetText);
            if (startChar !== -1) {
                const endChar = startChar + targetText.length;
                console.log(`  SINGLE_LINE_PRECISE: L${startLine + 1}:${startChar}-${endChar}`);
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

        console.log(`  MULTI_LINE_PRECISE: L${actualStartLine + 1}:${startChar}-L${actualEndLine + 1}:${endChar}`);

        return new vscode.Range(
            new vscode.Position(actualStartLine, startChar),
            new vscode.Position(actualEndLine, endChar)
        );
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
    }

    public async rejectParagraph(paragraphId: ParagraphIdentifier, editor: vscode.TextEditor): Promise<void> {
        console.log(`\n=== REJECT_PARAGRAPH: ${paragraphId} ===`);

        const paragraph = this.getParagraphCorrectionById(paragraphId);
        if (!paragraph || paragraph.status !== ParagraphStatus.Pending || !this.diffManager) {
            console.log(`REJECT_FAILED: paragraph not found or invalid status`);
            return;
        }

        console.log(`REJECT_ORIGINAL: "${paragraph.originalText}"`);
        console.log(`REJECT_CORRECTED: "${paragraph.correctedText}"`);
        console.log(`REJECT_RANGE: L${paragraph.range.start.line + 1}-L${paragraph.range.end.line + 1}`);

        // 检查是否有换行变化
        const originalLineCount = paragraph.originalText.split('\n').length;
        const correctedLineCount = (paragraph.correctedText || '').split('\n').length;
        const hasLineCountChange = originalLineCount !== correctedLineCount;

        console.log(`ORIGINAL_LINES: ${originalLineCount}, CORRECTED_LINES: ${correctedLineCount}, HAS_LINE_CHANGE: ${hasLineCountChange}`);

        const changeInfo = this.findChangeInfoForParagraph(paragraph);

        if (changeInfo && !hasLineCountChange) {
            // 没有换行变化，可以安全使用DiffManager的方法（不会闪烁）
            console.log(`REJECT_VIA_DIFFMANAGER (no line change)`);
            (this.diffManager as any).rejectSingleChange(changeInfo);
            paragraph.status = ParagraphStatus.Rejected;
            this._onDidChangeParagraphCorrections.fire();

            // 打印拒绝后的编辑器状态
            this.printEditorContent(editor, `AFTER_REJECT_${paragraphId}`);
        } else {
            // 有换行变化或找不到ChangeInfo，使用文档重构方法
            console.log(`REJECT_VIA_RECONSTRUCTION (line change or no ChangeInfo)`);

            // 先移除DiffManager中的change，避免干扰
            if (changeInfo) {
                try {
                    (this.diffManager as any).removeChangeFromList?.(changeInfo);
                } catch (error) {
                    console.warn(`Failed to remove DiffManager change:`, error);
                }
            }

            await this.rejectParagraphByDocumentReconstruction(editor, paragraph);
            paragraph.status = ParagraphStatus.Rejected;

            // 只更新其他段落的范围，避免完全重建装饰
            this.updateOtherParagraphRanges(editor, paragraph);

            this._onDidChangeParagraphCorrections.fire();

            // 打印拒绝后的编辑器状态
            this.printEditorContent(editor, `AFTER_REJECT_RECONSTRUCTION_${paragraphId}`);
        }

        console.log(`REJECT_DONE`);
    }

    /**
     * 更新其他段落的范围，避免完全重建装饰
     */
    private updateOtherParagraphRanges(editor: vscode.TextEditor, rejectedParagraph: ParagraphCorrection): void {
        console.log(`UPDATE_OTHER_PARAGRAPH_RANGES: starting`);

        // 只重新计算所有段落的范围
        this.recalculateAllParagraphRanges(editor);

        // 只更新DiffManager中其他段落的装饰位置
        if (this.diffManager) {
            console.log(`UPDATING_OTHER_PARAGRAPH_DECORATIONS`);

            const changes = (this.diffManager as any).changes as ChangeInfo[];
            if (changes) {
                // 为每个现有的change更新范围（跳过已拒绝的段落）
                for (const change of changes) {
                    const matchingParagraph = this.paragraphCorrections.find(p =>
                        p.originalText === change.original &&
                        p.correctedText === change.corrected &&
                        p.status === ParagraphStatus.Pending &&
                        p.id !== rejectedParagraph.id // 跳过刚拒绝的段落
                    );

                    if (matchingParagraph) {
                        console.log(`UPDATING_OTHER_CHANGE_RANGE: L${change.range.start.line + 1}-L${change.range.end.line + 1} -> L${matchingParagraph.range.start.line + 1}-L${matchingParagraph.range.end.line + 1}`);
                        change.range = matchingParagraph.range;
                    }
                }

                // 只更新装饰，不重建
                (this.diffManager as any).updateDecorations?.();
            }
        }

        console.log(`UPDATE_OTHER_PARAGRAPH_RANGES_COMPLETED`);
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

            editResult = await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, newFullText);
            }, {
                undoStopBefore: true,
                undoStopAfter: true
            });

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

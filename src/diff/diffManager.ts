import * as vscode from 'vscode';
import { EditorStateManager } from '../services/editorStateManager';

interface CharDiff {
    type: 'equal' | 'delete' | 'insert';
    text: string;
}

export interface ChangeInfo {
    range: vscode.Range;
    original: string;
    corrected: string;
    diffs: CharDiff[];
    accepted?: boolean;
}

interface EditorDecorations {
    deleteDecorationType: vscode.TextEditorDecorationType;
    insertDecorationType: vscode.TextEditorDecorationType;
    highlightDecorationType: vscode.TextEditorDecorationType;
}

export class DiffManager {
    private editorStateManager: EditorStateManager;
    private editorDecorations: Map<string, EditorDecorations> = new Map();
    private correctionService: any; // CorrectionService实例的引用

    constructor(editorStateManager: EditorStateManager) {
        this.editorStateManager = editorStateManager;
    }

    private getOrCreateDecorations(editor: vscode.TextEditor): EditorDecorations {
        const uri = editor.document.uri.toString();

        if (!this.editorDecorations.has(uri)) {
            const decorations: EditorDecorations = {
                deleteDecorationType: vscode.window.createTextEditorDecorationType({
                    backgroundColor: 'rgba(255, 0, 0, 0.3)',
                    textDecoration: 'line-through',
                    color: '#ff4444'
                }),
                insertDecorationType: vscode.window.createTextEditorDecorationType({
                    backgroundColor: 'rgba(0, 255, 0, 0.3)',
                    color: '#00aa00',
                    fontWeight: 'bold'
                }),
                highlightDecorationType: vscode.window.createTextEditorDecorationType({
                    backgroundColor: 'rgba(255, 165, 0, 0.4)',
                    border: '2px solid orange',
                    borderRadius: '3px'
                })
            };
            this.editorDecorations.set(uri, decorations);
        }

        return this.editorDecorations.get(uri)!;
    }

    /**
     * 设置CorrectionService实例
     * @param service CorrectionService实例
     */
    public setCorrectionService(service: any): void {
        this.correctionService = service;
    }

    public addChange(range: vscode.Range, original: string, corrected: string, targetEditor?: vscode.TextEditor): void {
        // 如果指定了目标编辑器，使用它；否则尝试获取有效编辑器
        const editor = targetEditor || this.editorStateManager.getValidEditor();
        if (!editor) {
            console.warn('No valid editor available for addChange');
            return;
        }

        const diffs = this.computeCharDiff(original, corrected);
        const change: ChangeInfo = {
            range,
            original,
            corrected,
            diffs,
            accepted: false
        };

        this.editorStateManager.addChange(editor, change);
        this.editorStateManager.markDecorationsNeedUpdate(editor);
        this.updateDecorationsForEditor(editor);
    }

    private computeCharDiff(original: string, corrected: string): CharDiff[] {
        // 使用更简单有效的Myers算法实现
        const diffs: CharDiff[] = [];
        const a = Array.from(original);
        const b = Array.from(corrected);

        const n = a.length;
        const m = b.length;

        // 动态规划表
        const dp: number[][] = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));

        // 填充DP表
        for (let i = 0; i <= n; i++) {
            dp[i][0] = i;
        }
        for (let j = 0; j <= m; j++) {
            dp[0][j] = j;
        }

        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = Math.min(
                        dp[i - 1][j] + 1,     // 删除
                        dp[i][j - 1] + 1,     // 插入
                        dp[i - 1][j - 1] + 1  // 替换
                    );
                }
            }
        }

        // 回溯构建diff序列
        let i = n, j = m;
        const operations: CharDiff[] = [];

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
                operations.unshift({ type: 'equal', text: a[i - 1] });
                i--;
                j--;
            } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
                // 替换操作：确保正确处理中文字符替换
                // 注意：对于替换操作，我们需要确保原文本和修改后文本的对应关系正确
                // 先添加删除操作，再添加插入操作，这样显示时顺序才正确
                const deleteOp = { type: 'delete' as const, text: a[i - 1] };
                const insertOp = { type: 'insert' as const, text: b[j - 1] };

                // 确保顺序正确：先删除原字符，再插入新字符
                operations.unshift(insertOp);
                operations.unshift(deleteOp);
                i--;
                j--;
            } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
                // 删除
                operations.unshift({ type: 'delete', text: a[i - 1] });
                i--;
            } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
                // 插入
                operations.unshift({ type: 'insert', text: b[j - 1] });
                j--;
            }
        }

        // 合并连续的相同操作类型
        return this.mergeContinuousOperations(operations);
    }

    private mergeContinuousOperations(operations: CharDiff[]): CharDiff[] {
        if (operations.length === 0) {
            return operations;
        }

        const merged: CharDiff[] = [];
        let current = { ...operations[0] };

        for (let i = 1; i < operations.length; i++) {
            if (operations[i].type === current.type) {
                current.text += operations[i].text;
            } else {
                merged.push(current);
                current = { ...operations[i] };
            }
        }
        merged.push(current);

        return merged;
    }

    public hasChanges(): boolean {
        // 检查所有编辑器是否有changes，而不只是当前活动的编辑器
        for (const editor of vscode.window.visibleTextEditors) {
            if (this.editorStateManager.getChanges(editor).length > 0) {
                return true;
            }
        }
        return false;
    }

    public clearChanges(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return;

        this.clearChangesForEditor(editor);
    }

    public clearChangesForEditor(editor: vscode.TextEditor): void {
        const changes = this.editorStateManager.getChanges(editor);
        
        this.editorStateManager.setChanges(editor, []);
        this.editorStateManager.updateEditorState(editor, { currentChangeIndex: 0 });
        this.clearDecorationsForEditor(editor);
    }

    public goToFirstChange(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return;

        const changes = this.editorStateManager.getChanges(editor);
        if (changes.length > 0) {
            this.editorStateManager.updateEditorState(editor, { currentChangeIndex: 0 });
            this.highlightCurrentChange();
        }
    }

    public acceptAllChanges(): Promise<void> {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return Promise.resolve();

        const changes = this.editorStateManager.getChanges(editor);
        changes.forEach(change => {
            change.accepted = true;
        });
        this.clearDecorations();

        return this.saveCurrentFile().then(() => {
            vscode.window.showInformationMessage(`已接受所有 ${changes.length} 处修改并保存文件`);
            this.editorStateManager.setChanges(editor, []); // 清空已处理的修改
        }).catch((err: any) => {
             vscode.window.showErrorMessage(`保存文件时发生错误: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    private async saveCurrentFile(): Promise<void> {
        const editor = this.editorStateManager.getValidEditor();
        if (editor && editor.document.isDirty) {
            try {
                await editor.document.save();
            } catch (error) {
                vscode.window.showErrorMessage(`保存文件失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    public rejectAllChanges(): Promise<void> {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) {
            return Promise.resolve(); // 返回一个已解决的 Promise
        }

        const changes = this.editorStateManager.getChanges(editor);
        const editorState = this.editorStateManager.getEditorState(editor);

        // 使用原始文档内容进行恢复
        if (editorState.originalDocumentContent) {
            // 直接使用原始文档内容进行恢复
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length)
            );

            editor.edit(editBuilder => {
                editBuilder.replace(fullRange, editorState.originalDocumentContent);
            });
        } else {
            // 如果无法获取原始文档内容，则回退到逐个撤销的方式
            const sortedChanges = [...changes].sort((a, b) =>
                b.range.start.compareTo(a.range.start)
            );

            editor.edit(editBuilder => {
                sortedChanges.forEach(change => {
                    if (!change.accepted) {
                        editBuilder.replace(change.range, change.original);
                    }
                });
            });
        }

        // (确保在所有修改被拒绝并恢复后)
        return this.saveCurrentFile().then(() => {
            vscode.window.showInformationMessage(`已拒绝所有 ${changes.length} 处修改并保存文件`);
            this.editorStateManager.setChanges(editor, []); // 清空已处理的修改
        }).catch((err: any) => {
            vscode.window.showErrorMessage(`保存文件时发生错误: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.clearDecorations(); // 拒绝后也应清除高亮
    }

    public goToNextChange(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return;

        const changes = this.editorStateManager.getChanges(editor);
        const state = this.editorStateManager.getEditorState(editor);

        if (changes.length === 0) {
            vscode.window.showInformationMessage('没有修改内容');
            return;
        }

        const newIndex = (state.currentChangeIndex + 1) % changes.length;
        this.editorStateManager.updateEditorState(editor, { currentChangeIndex: newIndex });
        this.highlightCurrentChange();
        
        // 更新状态栏
        vscode.commands.executeCommand('textCorrection.updateStatusBar');
    }

    public goToPreviousChange(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return;

        const changes = this.editorStateManager.getChanges(editor);
        const state = this.editorStateManager.getEditorState(editor);

        if (changes.length === 0) {
            vscode.window.showInformationMessage('没有修改内容');
            return;
        }

        const newIndex = (state.currentChangeIndex - 1 + changes.length) % changes.length;
        this.editorStateManager.updateEditorState(editor, { currentChangeIndex: newIndex });
        this.highlightCurrentChange();
        
        // 更新状态栏
        vscode.commands.executeCommand('textCorrection.updateStatusBar');
    }

    private updateDecorations(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) {
            return;
        }

        this.updateDecorationsForEditor(editor);
    }

    public updateDecorationsForEditor(editor: vscode.TextEditor): void {
        if (!editor || !this.editorStateManager.isEditorValid(editor)) {
            return;
        }

        this.applyDiffDecorations(editor);
        this.editorStateManager.markDecorationsApplied(editor);
    }

    private applyDiffDecorations(editor: vscode.TextEditor): void {
        const deleteDecorationOptions: vscode.DecorationOptions[] = [];
        const insertDecorationRanges: vscode.Range[] = [];
        const changes = this.editorStateManager.getChanges(editor);
        const decorations = this.getOrCreateDecorations(editor);

        // 先清除现有装饰
        editor.setDecorations(decorations.deleteDecorationType, []);
        editor.setDecorations(decorations.insertDecorationType, []);

        changes.forEach(change => {
            if (change.accepted) {
                return;
            }

            // 获取段落范围内的纠正后文本
            const document = editor.document;
            const correctedTextInRange = document.getText(change.range);

            // 使用更精确的位置计算方法
            const decorationPositions = this.calculateDiffPositions(change.range, change.diffs, correctedTextInRange);

            decorationPositions.forEach(pos => {
                if (pos.type === 'delete') {
                    deleteDecorationOptions.push({
                        range: pos.range,
                        renderOptions: {
                            before: {
                                contentText: pos.text,
                                backgroundColor: 'rgba(255, 0, 0, 0.2)',
                                textDecoration: 'line-through',
                                color: 'rgba(200, 0, 0, 0.7)',
                                margin: '0 0.1em 0 0.1em',
                            }
                        }
                    });
                } else if (pos.type === 'insert') {
                    insertDecorationRanges.push(pos.range);
                }
            });
        });

        // 应用装饰到特定编辑器
        editor.setDecorations(decorations.deleteDecorationType, deleteDecorationOptions);
        editor.setDecorations(decorations.insertDecorationType, insertDecorationRanges);
    }

    /**
     * 计算diff装饰的精确位置
     */
    private calculateDiffPositions(
        changeRange: vscode.Range,
        diffs: CharDiff[],
        correctedText: string
    ): Array<{type: 'delete' | 'insert', range: vscode.Range, text: string}> {
        const positions: Array<{type: 'delete' | 'insert', range: vscode.Range, text: string}> = [];

        // 将纠正后的文本按行分割
        const correctedLines = correctedText.split('\n');
        let currentLine = changeRange.start.line;
        let currentChar = changeRange.start.character;
        let correctedTextIndex = 0;

        diffs.forEach((diff, diffIndex) => {
            if (diff.type === 'equal') {
                // 相等的文本，移动位置指针
                const textLength = diff.text.length;
                const newPosition = this.advancePosition(currentLine, currentChar, diff.text, correctedLines, changeRange.start.character);
                currentLine = newPosition.line;
                currentChar = newPosition.character;
                correctedTextIndex += textLength;
            } else if (diff.type === 'insert') {
                // 插入的文本，创建绿色高亮范围
                const startPos = new vscode.Position(currentLine, currentChar);
                const newPosition = this.advancePosition(currentLine, currentChar, diff.text, correctedLines, changeRange.start.character);
                const endPos = new vscode.Position(newPosition.line, newPosition.character);

                positions.push({
                    type: 'insert',
                    range: new vscode.Range(startPos, endPos),
                    text: diff.text
                });

                currentLine = newPosition.line;
                currentChar = newPosition.character;
                correctedTextIndex += diff.text.length;
            } else if (diff.type === 'delete') {
                // 删除的文本，在当前位置创建零宽度范围
                const deletePos = new vscode.Position(currentLine, currentChar);
                positions.push({
                    type: 'delete',
                    range: new vscode.Range(deletePos, deletePos),
                    text: diff.text
                });
                // 注意：删除的文本不移动位置指针，因为它不存在于纠正后的文本中
            }
        });

        return positions;
    }

    /**
     * 在文本中前进位置，正确处理换行符
     */
    private advancePosition(
        currentLine: number,
        currentChar: number,
        text: string,
        correctedLines: string[],
        startChar: number
    ): {line: number, character: number} {
        let line = currentLine;
        let char = currentChar;

        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                line++;
                char = startChar; // 新行从段落起始字符位置开始
            } else {
                char++;
            }
        }

        return {line, character: char};
    }

    private highlightCurrentChange(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) return;

        const changes = this.editorStateManager.getChanges(editor);
        const state = this.editorStateManager.getEditorState(editor);

        if (changes.length === 0) {
            return;
        }

        const decorations = this.getOrCreateDecorations(editor);
        editor.setDecorations(decorations.highlightDecorationType, []);

        const currentChange = changes[state.currentChangeIndex];

        // 高亮当前修改
        editor.setDecorations(decorations.highlightDecorationType, [currentChange.range]);
        
        // 滚动编辑器到当前修改位置
        editor.revealRange(
            currentChange.range, 
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
        
        // 设置定时器，使高亮短暂显示后消失
        setTimeout(() => {
            // 确保编辑器仍然有效
            if (editor && this.editorStateManager.isEditorValid(editor)) {
                editor.setDecorations(decorations.highlightDecorationType, []);
            }
        }, 1500); // 1.5秒后清除高亮
    }

    private clearDecorations(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (editor) {
            this.clearDecorationsForEditor(editor);
        }
    }

    public clearDecorationsForEditor(editor: vscode.TextEditor): void {
        if (editor && this.editorStateManager.isEditorValid(editor)) {
            const decorations = this.getOrCreateDecorations(editor);
            editor.setDecorations(decorations.deleteDecorationType, []);
            editor.setDecorations(decorations.insertDecorationType, []);
            editor.setDecorations(decorations.highlightDecorationType, []);
        }
    }

    /**
     * 公开的段落拒绝方法
     */
    public async rejectParagraphChange(change: ChangeInfo): Promise<void> {
        // 找到包含这个change的编辑器
        let targetEditor: vscode.TextEditor | undefined;

        for (const editor of vscode.window.visibleTextEditors) {
            const changes = this.editorStateManager.getChanges(editor);
            if (changes.includes(change)) {
                targetEditor = editor;
                break;
            }
        }

        if (!targetEditor) {
            targetEditor = this.editorStateManager.getValidEditor();
        }

        if (!targetEditor || !this.editorStateManager.isEditorValid(targetEditor)) {
            vscode.window.showErrorMessage('拒绝段落修改失败: 找不到有效的编辑器');
            return;
        }

        try {
            // 简单地从变更列表中移除
            this.removeChangeFromList(change, targetEditor);
            this.updateDecorationsForEditor(targetEditor);
        } catch (error) {
            vscode.window.showErrorMessage(`拒绝段落修改失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 显示全局操作按钮（接受全部/拒绝全部）的提示信息
     */
    public showGlobalActionButtons(): void {
        const editor = this.editorStateManager.getValidEditor();
        if (!editor) {
            return;
        }

        if (!this.hasChanges()) {
            vscode.window.showInformationMessage("没有检测到任何更改。");
            return;
        }

        const message = "文本纠正完成，请选择操作：";
        const acceptAllOption = "✓ 接受全部";
        const rejectAllOption = "✗ 拒绝全部";

        vscode.window.showInformationMessage(message, acceptAllOption, rejectAllOption)
            .then(selection => {
                if (selection === acceptAllOption) {
                    this.acceptAllChanges();
                } else if (selection === rejectAllOption) {
                    this.rejectAllChanges();
                } else {
                    this.rejectAllChanges();
                }
            });
    }

    public dispose(): void {
        // 清理所有编辑器的装饰类型
        for (const decorations of this.editorDecorations.values()) {
            decorations.deleteDecorationType.dispose();
            decorations.insertDecorationType.dispose();
            decorations.highlightDecorationType.dispose();
        }
        this.editorDecorations.clear();
    }

    /**
     * 清理已关闭编辑器的装饰
     */
    public cleanupClosedEditors(): void {
        const openUris = new Set(
            vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString())
        );

        for (const [uri, decorations] of this.editorDecorations.entries()) {
            if (!openUris.has(uri)) {
                decorations.deleteDecorationType.dispose();
                decorations.insertDecorationType.dispose();
                decorations.highlightDecorationType.dispose();
                this.editorDecorations.delete(uri);
            }
        }
    }

    private removeChangeFromList(change: ChangeInfo, targetEditor?: vscode.TextEditor): void {
        const editor = targetEditor || this.editorStateManager.getValidEditor();
        if (!editor) {
            console.warn('No valid editor available for removeChangeFromList');
            return;
        }

        // 获取当前索引和变更总数
        const state = this.editorStateManager.getEditorState(editor);
        const currentIndex = state.currentChangeIndex;
        const changes = this.editorStateManager.getChanges(editor);
        const totalChanges = changes.length;
        
        // 找到要删除的变更的索引
        const indexToRemove = changes.indexOf(change);
        if (indexToRemove === -1) {
            return; // 没有找到要删除的变更
        }
        
        // 从变更列表中移除
        this.editorStateManager.removeChange(editor, change);
        
        // 获取更新后的变更列表和总数
        const updatedChanges = this.editorStateManager.getChanges(editor);
        const updatedTotal = updatedChanges.length;
        
        // 更新当前索引
        let newIndex = currentIndex;
        
        // 如果删除的是当前显示的变更
        if (indexToRemove === currentIndex) {
            // 如果删除的是最后一个，则指向新的最后一个
            if (indexToRemove >= updatedTotal) {
                newIndex = Math.max(0, updatedTotal - 1);
            }
            // 否则保持当前索引不变（因为后面的变更会自动前移）
        }
        // 如果删除的是当前显示的变更之前的变更
        else if (indexToRemove < currentIndex) {
            // 当前索引需要减1，因为前面少了一个变更
            newIndex = Math.max(0, currentIndex - 1);
        }
        // 如果删除的是当前显示的变更之后的变更，当前索引不变
        
        // 更新编辑器状态
        this.editorStateManager.updateEditorState(editor, {
            currentChangeIndex: newIndex
        });
    }
}

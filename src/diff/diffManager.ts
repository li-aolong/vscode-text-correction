import * as vscode from 'vscode';

interface CharDiff {
    type: 'equal' | 'delete' | 'insert';
    text: string;
}

interface ChangeInfo {
    range: vscode.Range;
    original: string;
    corrected: string;
    diffs: CharDiff[];
    accepted?: boolean;
    webviewPanel?: vscode.WebviewPanel;
}

export class DiffManager {
    private changes: ChangeInfo[] = [];
    private currentChangeIndex = 0;
    private deleteDecorationType: vscode.TextEditorDecorationType;
    private insertDecorationType: vscode.TextEditorDecorationType;
    private highlightDecorationType: vscode.TextEditorDecorationType;
    private correctionService: any; // CorrectionService实例的引用

    constructor() {
        this.deleteDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.3)',
            textDecoration: 'line-through',
            color: '#ff4444'
        });

        this.insertDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.3)',
            color: '#00aa00',
            fontWeight: 'bold'
        });

        this.highlightDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 165, 0, 0.4)',
            border: '2px solid orange',
            borderRadius: '3px'
        });
    }
    
    /**
     * 设置CorrectionService实例
     * @param service CorrectionService实例
     */
    public setCorrectionService(service: any): void {
        this.correctionService = service;
    }

    public addChange(range: vscode.Range, original: string, corrected: string): void {
        const diffs = this.computeCharDiff(original, corrected);
        this.changes.push({
            range,
            original,
            corrected,
            diffs,
            accepted: false
        });
        this.updateDecorations();
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
        return this.changes.length > 0;
    }

    public clearChanges(): void {
        this.changes.forEach(change => {
            if (change.webviewPanel) {
                change.webviewPanel.dispose();
            }
        });
        this.changes = [];
        this.currentChangeIndex = 0;
        this.clearDecorations();
    }

    public goToFirstChange(): void {
        if (this.changes.length > 0) {
            this.currentChangeIndex = 0;
            this.highlightCurrentChange();
        }
    }

    public acceptAllChanges(): void {
        this.changes.forEach(change => {
            change.accepted = true;
            if (change.webviewPanel) {
                change.webviewPanel.dispose();
            }
        });
        this.clearDecorations();
        
        this.saveCurrentFile().then(() => {
            vscode.window.showInformationMessage(`已接受所有 ${this.changes.length} 处修改并保存文件`);
            this.changes = []; // 清空已处理的修改
        }).catch(err => {
             vscode.window.showErrorMessage(`保存文件时发生错误: ${err}`);
        });
    }

    private async saveCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.isDirty) {
            try {
                await editor.document.save();
            } catch (error) {
                vscode.window.showErrorMessage(`保存文件失败: ${error}`);
            }
        }
    }

    public rejectAllChanges(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        
        // 使用原始文档内容进行恢复
        if (this.correctionService && this.correctionService.originalDocumentContent) {
            // 直接使用原始文档内容进行恢复
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length)
            );
            
            editor.edit(editBuilder => {
                editBuilder.replace(fullRange, this.correctionService.originalDocumentContent);
            });
        } else {
            // 如果无法获取原始文档内容，则回退到逐个撤销的方式
            const sortedChanges = [...this.changes].sort((a, b) =>
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

        this.changes.forEach(change => {
            if (change.webviewPanel) {
                change.webviewPanel.dispose();
            }
        });

        // (确保在所有修改被拒绝并恢复后)
        this.saveCurrentFile().then(() => {
            vscode.window.showInformationMessage(`已拒绝所有 ${this.changes.length} 处修改并保存文件`);
            this.changes = []; // 清空已处理的修改
        }).catch(err => {
            vscode.window.showErrorMessage(`保存文件时发生错误: ${err}`);
        });
        this.clearDecorations(); // 拒绝后也应清除高亮
    }

    public goToNextChange(): void {
        if (this.changes.length === 0) {
            vscode.window.showInformationMessage('没有修改内容');
            return;
        }

        this.currentChangeIndex = (this.currentChangeIndex + 1) % this.changes.length;
        this.highlightCurrentChange();
    }

    public goToPreviousChange(): void {
        if (this.changes.length === 0) {
            vscode.window.showInformationMessage('没有修改内容');
            return;
        }

        this.currentChangeIndex = (this.currentChangeIndex - 1 + this.changes.length) % this.changes.length;
        this.highlightCurrentChange();
    }

    private updateDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        this.applyDiffDecorations(editor);
    }

    private applyDiffDecorations(editor: vscode.TextEditor): void {
        const deleteDecorationOptions: vscode.DecorationOptions[] = [];
        const insertDecorationRanges: vscode.Range[] = [];
    
        this.changes.forEach(change => {
            if (change.accepted) {
                return;
            }
    
            // 假设：编辑器在 change.range 范围内显示的是 change.corrected (校正后) 的文本。
            let currentPosInCorrectedText = change.range.start;
            const document = editor.document;
    
            change.diffs.forEach(diff => {
                const diffSegmentLength = diff.text.length;
    
                if (diff.type === 'equal') {
                    // 此文本段存在于校正后的编辑器文本中。
                    // 将 currentPosInCorrectedText 前进到此段之后。
                    currentPosInCorrectedText = document.positionAt(
                        document.offsetAt(currentPosInCorrectedText) + diffSegmentLength
                    );
                } else if (diff.type === 'insert') {
                    // 此文本段是插入的部分，存在于校正后的编辑器文本中。
                    // 定义此插入文本的范围。
                    const endPosInCorrectedText = document.positionAt(
                        document.offsetAt(currentPosInCorrectedText) + diffSegmentLength
                    );
                    const insertedTextRange = new vscode.Range(currentPosInCorrectedText, endPosInCorrectedText);
                    insertDecorationRanges.push(insertedTextRange);
    
                    // 将 currentPosInCorrectedText 前进到此插入段之后。
                    currentPosInCorrectedText = endPosInCorrectedText;
                } else if (diff.type === 'delete') {
                    // 被删除的文本 (diff.text) 不在校正后的文本流中。
                    // 我们在删除发生的位置创建一个零宽度范围，并使用 'before' 伪元素显示已删除的文本。
                    const deletionPointRange = new vscode.Range(currentPosInCorrectedText, currentPosInCorrectedText);
                    
                    deleteDecorationOptions.push({
                        range: deletionPointRange,
                        renderOptions: {
                            before: {
                                contentText: diff.text, // 要显示的已删除文本
                                backgroundColor: 'rgba(255, 0, 0, 0.2)', // 删除标记的背景色 (可调整)
                                textDecoration: 'line-through',        // 删除线
                                color: 'rgba(200, 0, 0, 0.7)',          // 删除标记的文本颜色 (可调整)
                                margin: '0 0.1em 0 0.1em',            // 轻微的边距，使其与周围文本分开
                                // fontStyle: 'italic',               // 可选：斜体
                                // 对于中文字符，可能需要调整边距或字体以获得最佳视觉效果
                            }
                        }
                    });
    
                    // 重要：currentPosInCorrectedText 不应前进，因为删除的文本是视觉注入的，
                    // 并不属于文档中校正后文本流的一部分。
                }
            });
        });
    
        // 应用装饰
        // this.deleteDecorationType 在构造函数中定义的样式将应用于零宽度范围本身（通常不可见）。
        // 真正可见的删除文本样式由上面 renderOptions.before 中的设置决定。
        editor.setDecorations(this.deleteDecorationType, deleteDecorationOptions);
        editor.setDecorations(this.insertDecorationType, insertDecorationRanges);
    }

    private highlightCurrentChange(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || this.changes.length === 0) {
            return;
        }

        editor.setDecorations(this.highlightDecorationType, []);

        const currentChange = this.changes[this.currentChangeIndex];

        editor.setDecorations(this.highlightDecorationType, [currentChange.range]);

        editor.selection = new vscode.Selection(currentChange.range.start, currentChange.range.end);
        editor.revealRange(currentChange.range, vscode.TextEditorRevealType.InCenter);

        this.showActionPanel(currentChange);
    }

    private showActionPanel(change: ChangeInfo): void {
        if (change.webviewPanel) {
            change.webviewPanel.dispose();
        }

        const changeNumber = this.currentChangeIndex + 1;
        const totalChanges = this.changes.length;
        const diffText = this.formatDiffForDisplay(change.diffs);

        const panel = vscode.window.createWebviewPanel(
            'textCorrectionDiff',
            `修改 ${changeNumber}/${totalChanges}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        change.webviewPanel = panel;

        panel.webview.html = this.getWebviewContent(diffText, changeNumber, totalChanges);

        panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'accept':
                    this.acceptSingleChange(change);
                    break;
                case 'reject':
                    this.rejectSingleChange(change);
                    break;
                case 'previous':
                    this.goToPreviousChange();
                    break;
                case 'next':
                    this.goToNextChange();
                    break;
                case 'acceptAll':
                    this.acceptAllChanges();
                    break;
                case 'rejectAll':
                    this.rejectAllChanges();
                    break;
            }
        });

        panel.onDidDispose(() => {
            if (change.webviewPanel === panel) {
                change.webviewPanel = undefined;
            }
        });
    }

    private getWebviewContent(diffText: string, changeNumber: number, totalChanges: number): string {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>文本修改</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                    margin: 0;
                }
                .diff-container {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 5px;
                    padding: 15px;
                    margin-bottom: 20px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    line-height: 1.5;
                }
                .diff-text {
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }
                .delete {
                    background-color: rgba(255, 0, 0, 0.3);
                    text-decoration: line-through;
                    color: #ff4444;
                }
                .insert {
                    background-color: rgba(0, 255, 0, 0.3);
                    color: #00aa00;
                    font-weight: bold;
                }
                .button-group {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                    margin-bottom: 15px;
                }
                .nav-group {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 13px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .accept-btn {
                    background-color: var(--vscode-button-background);
                }
                .reject-btn {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                .nav-btn {
                    background-color: var(--vscode-button-background);
                }
                .batch-btn {
                    background-color: var(--vscode-button-background);
                }
                .title {
                    font-size: 16px;
                    font-weight: bold;
                    margin-bottom: 15px;
                    color: var(--vscode-foreground);
                }
            </style>
        </head>
        <body>
            <div class="title">修改 ${changeNumber}/${totalChanges}</div>
            
            <div class="diff-container">
                <div class="diff-text">${this.formatDiffForHtml(diffText)}</div>
            </div>
            
            <div class="button-group">
                <button class="accept-btn" onclick="sendMessage('accept')">✓ 接受此修改</button>
                <button class="reject-btn" onclick="sendMessage('reject')">✗ 拒绝此修改</button>
            </div>
            
            <div class="nav-group">
                <button class="nav-btn" onclick="sendMessage('previous')">← 上一个</button>
                <button class="nav-btn" onclick="sendMessage('next')">下一个 →</button>
            </div>
            
            <div class="button-group" style="margin-top: 20px;">
                <button class="batch-btn" onclick="sendMessage('acceptAll')">接受全部修改</button>
                <button class="batch-btn" onclick="sendMessage('rejectAll')">拒绝全部修改</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                function sendMessage(command) {
                    vscode.postMessage({ command: command });
                }
            </script>
        </body>
        </html>`;
    }

    private formatDiffForDisplay(diffs: CharDiff[]): string {
        let result = '';
        diffs.forEach(diff => {
            switch (diff.type) {
                case 'delete':
                    result += `[-${diff.text}]`;
                    break;
                case 'insert':
                    result += `[+${diff.text}]`;
                    break;
                case 'equal':
                    result += diff.text;
                    break;
            }
        });
        return result;
    }

    private formatDiffForHtml(diffText: string): string {
        // 先对文本内容进行HTML特殊字符转义
        let escapedText = diffText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // 然后添加HTML标签
        return escapedText
            .replace(/\[-(.*?)\]/g, '<span class="delete">$1</span>')
            .replace(/\[\+(.*?)\]/g, '<span class="insert">$1</span>');
    }

    private acceptSingleChange(change: ChangeInfo): void {
        change.accepted = true;
        if (change.webviewPanel) {
            change.webviewPanel.dispose();
            change.webviewPanel = undefined;
        }
        this.removeChangeFromList(change);
        this.updateDecorations();

        if (this.changes.length > 0) {
            if (this.currentChangeIndex >= this.changes.length) {
                this.currentChangeIndex = 0;
            }
            this.highlightCurrentChange();
        } else {
            // 所有修改处理完成后保存文件
            this.saveCurrentFile();
            vscode.window.showInformationMessage('所有修改已处理完成并保存文件！');
        }
    }

    private rejectSingleChange(change: ChangeInfo): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        // 直接使用编辑器的文本替换功能，保持原始文本的精确格式
        editor.edit(editBuilder => {
            // 直接使用原始文本，不做任何处理
            editBuilder.replace(change.range, change.original);
        });

        if (change.webviewPanel) {
            change.webviewPanel.dispose();
            change.webviewPanel = undefined;
        }

        this.removeChangeFromList(change);
        this.updateDecorations();

        if (this.changes.length > 0) {
            if (this.currentChangeIndex >= this.changes.length) {
                this.currentChangeIndex = 0;
            }
            this.highlightCurrentChange();
        } else {
            // 所有修改处理完成后保存文件
            this.saveCurrentFile();
            vscode.window.showInformationMessage('所有修改已处理完成并保存文件！');
        }
    }

    private removeChangeFromList(change: ChangeInfo): void {
        const index = this.changes.indexOf(change);
        if (index > -1) {
            this.changes.splice(index, 1);
            if (this.currentChangeIndex >= this.changes.length) {
                this.currentChangeIndex = Math.max(0, this.changes.length - 1);
            }
        }
    }

    private clearDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(this.deleteDecorationType, []);
            editor.setDecorations(this.insertDecorationType, []);
            editor.setDecorations(this.highlightDecorationType, []);
        }
    }

        /**
     * 显示全局操作按钮（接受全部/拒绝全部）的提示信息
     */
    public showGlobalActionButtons(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            // 通常不应该在这里发生，因为 correctFullText 会检查 editor
            return;
        }

        if (!this.hasChanges()) {
            vscode.window.showInformationMessage("没有检测到任何更改。");
            return;
        }

        const message = "文本纠正完成，请选择操作：";
        const acceptAllOption = "✓ 接受全部";
        const rejectAllOption = "✗ 拒绝全部";

        vscode.window.showInformationMessage(message, { modal: true }, acceptAllOption, rejectAllOption)
            .then(selection => {
                if (selection === acceptAllOption) {
                    this.acceptAllChanges();
                } else if (selection === rejectAllOption) {
                    this.rejectAllChanges();
                } else {
                    // 用户关闭了提示框或选择了其他（理论上不应该有其他选项）
                    // 默认行为可以是拒绝全部，以清理状态
                    this.rejectAllChanges();
                }
            });
    }


    public dispose(): void {
        this.changes.forEach(change => {
            if (change.webviewPanel) {
                change.webviewPanel.dispose();
            }
        });
        this.deleteDecorationType.dispose();
        this.insertDecorationType.dispose();
        this.highlightDecorationType.dispose();
    }
}

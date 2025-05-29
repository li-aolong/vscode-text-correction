import * as vscode from 'vscode';
import { EditorStateManager } from './editorStateManager';

/**
 * 文档编辑服务 - 负责对文档进行编辑操作
 */
export class DocumentEditService {
    private editorStateManager: EditorStateManager;

    constructor(editorStateManager: EditorStateManager) {
        this.editorStateManager = editorStateManager;
    }

    /**
     * 应用纠正到编辑器
     */
    public async applyCorrectionToEditor(
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
     * 保存文件
     */
    public async saveFile(editor: vscode.TextEditor): Promise<void> {
        try {
            await editor.document.save();
        } catch (error) {
            console.error('Failed to save file:', error);
            throw new Error(`保存文件失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 打印编辑器的完整内容，用于调试
     */
    public printEditorContent(editor: vscode.TextEditor, label: string): void {
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

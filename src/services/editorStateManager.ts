import * as vscode from 'vscode';
import { ParagraphCorrection, ParagraphStatus } from './correctionService';
import { ChangeInfo } from '../diff/diffManager';

/**
 * 单个编辑器的状态信息
 */
export interface EditorState {
    uri: string;
    isCorrectingInProgress: boolean;
    originalDocumentContent: string;
    paragraphCorrections: ParagraphCorrection[];
    changes: ChangeInfo[];
    currentChangeIndex: number;
    isCancelled: boolean;
    decorationsApplied: boolean; // 标记装饰是否已应用
    lastDecorationUpdate: number; // 最后一次装饰更新时间
}

/**
 * 管理多个编辑器的独立状态
 */
export class EditorStateManager {
    private editorStates: Map<string, EditorState> = new Map();
    private editorInstances: Map<string, vscode.TextEditor> = new Map(); // 保存编辑器实例引用
    private _onDidChangeEditorState: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onDidChangeEditorState: vscode.Event<string> = this._onDidChangeEditorState.event;

    /**
     * 注册编辑器实例
     */
    public registerEditor(editor: vscode.TextEditor): void {
        const uri = editor.document.uri.toString();
        this.editorInstances.set(uri, editor);
    }

    /**
     * 获取编辑器实例
     */
    public getEditorInstance(uri: string): vscode.TextEditor | undefined {
        return this.editorInstances.get(uri);
    }

    /**
     * 验证编辑器是否仍然有效
     */
    public isEditorValid(editor: vscode.TextEditor): boolean {
        try {
            // 尝试访问编辑器的文档来验证它是否仍然有效
            const _ = editor.document.uri;
            const __ = editor.document.getText();
            return true;
        } catch (error) {
            console.warn('Editor is no longer valid:', error);
            return false;
        }
    }

    /**
     * 检查编辑器是否可见（用于UI操作）
     */
    public isEditorVisible(editor: vscode.TextEditor): boolean {
        return vscode.window.visibleTextEditors.some(e =>
            e.document.uri.toString() === editor.document.uri.toString()
        );
    }

    /**
     * 获取有效的编辑器实例（优先使用保存的实例，回退到活动编辑器）
     */
    public getValidEditor(uri?: string): vscode.TextEditor | undefined {
        // 如果指定了URI，先尝试从可见编辑器中找到匹配的编辑器
        if (uri) {
            const visibleEditor = vscode.window.visibleTextEditors.find(e =>
                e.document.uri.toString() === uri
            );
            if (visibleEditor) {
                this.registerEditor(visibleEditor);
                return visibleEditor;
            }

            // 如果可见编辑器中没有，再尝试保存的实例
            const savedEditor = this.editorInstances.get(uri);
            if (savedEditor && this.isEditorValid(savedEditor)) {
                return savedEditor;
            }
        }

        // 回退到活动编辑器
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && this.isEditorValid(activeEditor)) {
            // 更新保存的编辑器实例
            this.registerEditor(activeEditor);
            return activeEditor;
        }

        return undefined;
    }

    /**
     * 根据URI获取编辑器实例
     */
    public getEditorByUri(uri: string): vscode.TextEditor | undefined {
        return this.getValidEditor(uri);
    }

    /**
     * 获取编辑器状态，如果不存在则创建新的
     */
    public getEditorState(editor: vscode.TextEditor): EditorState {
        const uri = editor.document.uri.toString();

        // 注册编辑器实例
        this.registerEditor(editor);

        if (!this.editorStates.has(uri)) {
            this.editorStates.set(uri, {
                uri,
                isCorrectingInProgress: false,
                originalDocumentContent: '',
                paragraphCorrections: [],
                changes: [],
                currentChangeIndex: 0,
                isCancelled: false,
                decorationsApplied: false,
                lastDecorationUpdate: 0
            });
        }

        return this.editorStates.get(uri)!;
    }

    /**
     * 获取当前活动编辑器的状态
     */
    public getCurrentEditorState(): EditorState | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }
        return this.getEditorState(editor);
    }

    /**
     * 更新编辑器状态
     */
    public updateEditorState(editor: vscode.TextEditor, updates: Partial<EditorState>): void {
        const state = this.getEditorState(editor);
        Object.assign(state, updates);
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 清除编辑器的纠错状态
     */
    public clearEditorCorrectionState(editor: vscode.TextEditor): void {
        const state = this.getEditorState(editor);
        state.paragraphCorrections = [];
        state.changes = [];
        state.currentChangeIndex = 0;
        state.isCancelled = false;
        state.isCorrectingInProgress = false;
        state.originalDocumentContent = '';
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 检查编辑器是否有待处理的更改
     */
    public hasChanges(editor: vscode.TextEditor): boolean {
        const state = this.getEditorState(editor);
        return state.changes.length > 0 || state.paragraphCorrections.some(pc => pc.status === ParagraphStatus.Pending);
    }

    /**
     * 检查编辑器是否正在纠错
     */
    public isCorrectingInProgress(editor: vscode.TextEditor): boolean {
        const state = this.getEditorState(editor);
        return state.isCorrectingInProgress;
    }

    /**
     * 获取编辑器的段落纠正信息
     */
    public getParagraphCorrections(editor: vscode.TextEditor): ParagraphCorrection[] {
        const state = this.getEditorState(editor);
        return state.paragraphCorrections;
    }

    /**
     * 设置编辑器的段落纠正信息
     */
    public setParagraphCorrections(editor: vscode.TextEditor, corrections: ParagraphCorrection[]): void {
        const state = this.getEditorState(editor);
        state.paragraphCorrections = corrections;
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 添加段落纠正信息
     */
    public addParagraphCorrection(editor: vscode.TextEditor, correction: ParagraphCorrection): void {
        const state = this.getEditorState(editor);
        state.paragraphCorrections.push(correction);
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 获取编辑器的变更信息
     */
    public getChanges(editor: vscode.TextEditor): ChangeInfo[] {
        const state = this.getEditorState(editor);
        return state.changes;
    }

    /**
     * 设置编辑器的变更信息
     */
    public setChanges(editor: vscode.TextEditor, changes: ChangeInfo[]): void {
        const state = this.getEditorState(editor);
        state.changes = changes;
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 添加变更信息
     */
    public addChange(editor: vscode.TextEditor, change: ChangeInfo): void {
        const state = this.getEditorState(editor);
        state.changes.push(change);
        this._onDidChangeEditorState.fire(state.uri);
    }

    /**
     * 移除变更信息
     */
    public removeChange(editor: vscode.TextEditor, change: ChangeInfo): void {
        const state = this.getEditorState(editor);
        const index = state.changes.indexOf(change);
        if (index > -1) {
            state.changes.splice(index, 1);
            this._onDidChangeEditorState.fire(state.uri);
        }
    }

    /**
     * 标记装饰已应用
     */
    public markDecorationsApplied(editor: vscode.TextEditor): void {
        const state = this.getEditorState(editor);
        state.decorationsApplied = true;
        state.lastDecorationUpdate = Date.now();
    }

    /**
     * 标记装饰需要重新应用
     */
    public markDecorationsNeedUpdate(editor: vscode.TextEditor): void {
        const state = this.getEditorState(editor);
        state.decorationsApplied = false;
    }

    /**
     * 检查装饰是否需要应用
     */
    public needsDecorationUpdate(editor: vscode.TextEditor): boolean {
        const state = this.getEditorState(editor);
        return !state.decorationsApplied && state.changes.length > 0;
    }

    /**
     * 获取装饰状态信息
     */
    public getDecorationState(editor: vscode.TextEditor): { applied: boolean; lastUpdate: number; changesCount: number } {
        const state = this.getEditorState(editor);
        return {
            applied: state.decorationsApplied,
            lastUpdate: state.lastDecorationUpdate,
            changesCount: state.changes.length
        };
    }

    /**
     * 清理已关闭编辑器的状态
     * 注意：只清理真正关闭的编辑器，不清理暂时不可见的编辑器
     */
    public cleanupClosedEditors(): void {
        // 获取所有打开的文档URI（包括不可见的标签页）
        const openUris = new Set(
            vscode.workspace.textDocuments.map(doc => doc.uri.toString())
        );

        // 只清理真正关闭的文档的状态
        const statesToDelete: string[] = [];
        for (const uri of this.editorStates.keys()) {
            if (!openUris.has(uri)) {
                statesToDelete.push(uri);
            }
        }

        // 清理状态
        for (const uri of statesToDelete) {
            this.editorStates.delete(uri);
        }

        // 清理编辑器实例引用（这里可以更激进一些，因为实例引用可以重新创建）
        const visibleUris = new Set(
            vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString())
        );

        for (const uri of this.editorInstances.keys()) {
            if (!visibleUris.has(uri)) {
                this.editorInstances.delete(uri);
            }
        }
    }

    /**
     * 释放资源
     */
    public dispose(): void {
        this.editorStates.clear();
        this._onDidChangeEditorState.dispose();
    }
}

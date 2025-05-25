import * as vscode from 'vscode';
import { EditorStateManager } from '../services/editorStateManager';
import { CostCalculator } from '../services/costCalculator';

/**
 * 单个编辑器的状态栏项目集合
 */
interface EditorStatusBarItems {
    uri: string;
    costStatusBarItem: vscode.StatusBarItem;
    actualCostStatusBarItem: vscode.StatusBarItem; // 新增：实际花费状态栏
    correctionStatusBarItem: vscode.StatusBarItem;
    cancelStatusBarItem: vscode.StatusBarItem;
    acceptAllStatusBarItem: vscode.StatusBarItem;
    rejectAllStatusBarItem: vscode.StatusBarItem;
}

/**
 * 管理每个编辑器独立的状态栏项目
 */
export class StatusBarManager {
    private editorStatusBars: Map<string, EditorStatusBarItems> = new Map();
    private editorStateManager: EditorStateManager;
    private costCalculator: CostCalculator;

    constructor(editorStateManager: EditorStateManager, costCalculator: CostCalculator) {
        this.editorStateManager = editorStateManager;
        this.costCalculator = costCalculator;
    }

    /**
     * 获取或创建编辑器的状态栏项目
     */
    private getOrCreateStatusBarItems(editor: vscode.TextEditor): EditorStatusBarItems {
        const uri = editor.document.uri.toString();

        if (!this.editorStatusBars.has(uri)) {
            const items: EditorStatusBarItems = {
                uri,
                costStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 6),
                actualCostStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5),
                correctionStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4),
                cancelStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3),
                acceptAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2),
                rejectAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1)
            };

            // 设置纠错按钮的初始状态
            items.correctionStatusBarItem.text = "$(pencil) 全文纠错";
            items.correctionStatusBarItem.command = 'textCorrection.correctFullText';

            // 设置取消按钮
            items.cancelStatusBarItem.text = "$(x)";
            items.cancelStatusBarItem.command = 'textCorrection.cancelCorrection';
            items.cancelStatusBarItem.tooltip = "取消纠错";

            // 设置接受全部按钮
            items.acceptAllStatusBarItem.text = "$(check-all) 全接受";
            items.acceptAllStatusBarItem.command = 'textCorrection.acceptAllChanges';
            items.acceptAllStatusBarItem.tooltip = "接受所有更改";

            // 设置拒绝全部按钮
            items.rejectAllStatusBarItem.text = "$(close-all) 全拒绝";
            items.rejectAllStatusBarItem.command = 'textCorrection.rejectAllChanges';
            items.rejectAllStatusBarItem.tooltip = "拒绝所有更改";

            this.editorStatusBars.set(uri, items);
        }

        return this.editorStatusBars.get(uri)!;
    }

    /**
     * 显示指定编辑器的状态栏
     */
    public showStatusBarForEditor(editor: vscode.TextEditor): void {
        // 隐藏所有其他编辑器的状态栏
        this.hideAllStatusBars();

        // 显示当前编辑器的状态栏
        const items = this.getOrCreateStatusBarItems(editor);
        const state = this.editorStateManager.getEditorState(editor);

        items.costStatusBarItem.show();
        items.actualCostStatusBarItem.show();
        items.correctionStatusBarItem.show();

        // 根据编辑器状态决定其他按钮的显示和内容
        this.updateStatusBarForEditor(editor);
    }

    /**
     * 隐藏所有状态栏项目
     */
    private hideAllStatusBars(): void {
        for (const items of this.editorStatusBars.values()) {
            items.costStatusBarItem.hide();
            items.actualCostStatusBarItem.hide();
            items.correctionStatusBarItem.hide();
            items.cancelStatusBarItem.hide();
            items.acceptAllStatusBarItem.hide();
            items.rejectAllStatusBarItem.hide();
        }
    }

    /**
     * 更新指定编辑器的状态栏内容
     */
    public updateStatusBarForEditor(editor: vscode.TextEditor): void {
        const items = this.getOrCreateStatusBarItems(editor);
        const state = this.editorStateManager.getEditorState(editor);

        // 更新费用预估和实际花费
        this.updateCostStatusBar(editor, items);
        this.updateActualCostStatusBar(editor, items);

        // 更新纠错状态
        if (state.isCorrectingInProgress) {
            items.correctionStatusBarItem.command = undefined; // 禁用命令
            items.correctionStatusBarItem.text = "$(loading~spin) 纠错中...";
            items.cancelStatusBarItem.show();
        } else if (this.editorStateManager.hasChanges(editor)) {
            // 有diff信息时禁用全文纠错按钮
            items.correctionStatusBarItem.command = undefined; // 禁用命令
            items.correctionStatusBarItem.text = "$(pencil) 全文纠错 (请先处理当前修改)";
            items.cancelStatusBarItem.hide();
        } else {
            items.correctionStatusBarItem.text = "$(pencil) 全文纠错";
            items.correctionStatusBarItem.command = 'textCorrection.correctFullText';
            items.cancelStatusBarItem.hide();
        }

        // 更新操作按钮的可见性
        this.updateActionButtonsVisibility(editor, items);
    }

    /**
     * 更新费用预估状态栏
     */
    private updateCostStatusBar(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        const fullText = editor.document.getText();
        const fullTextCost = this.costCalculator.estimateCost(fullText);

        const selection = editor.selection;
        let statusText = `全文纠错预估: ${fullTextCost}`;

        if (!selection.isEmpty) {
            const selectedText = editor.document.getText(selection);
            const selectedCost = this.costCalculator.estimateCost(selectedText);
            statusText += ` | 选中内容: ${selectedCost}`;
        }

        items.costStatusBarItem.text = statusText;
    }

    /**
     * 更新实际花费状态栏
     */
    private updateActualCostStatusBar(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        const state = this.editorStateManager.getEditorState(editor);

        if (state.totalActualCost > 0 || state.totalInputTokens > 0 || state.totalOutputTokens > 0) {
            const formattedCost = this.costCalculator.formatCost(state.totalActualCost);
            const totalTokens = state.totalInputTokens + state.totalOutputTokens;

            items.actualCostStatusBarItem.text = `$(credit-card) 已花费: ${formattedCost} | Tokens: ${totalTokens} (输入:${state.totalInputTokens}, 输出:${state.totalOutputTokens})`;
            items.actualCostStatusBarItem.tooltip = `累计花费详情:\n输入Token: ${state.totalInputTokens}\n输出Token: ${state.totalOutputTokens}\n总Token: ${totalTokens}\n实际花费: ${formattedCost}`;
        } else {
            items.actualCostStatusBarItem.text = "$(credit-card) 已花费: 0";
            items.actualCostStatusBarItem.tooltip = "尚未产生费用";
        }
    }

    /**
     * 更新操作按钮的可见性
     */
    private updateActionButtonsVisibility(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        if (this.editorStateManager.hasChanges(editor)) {
            items.acceptAllStatusBarItem.show();
            items.rejectAllStatusBarItem.show();
        } else {
            items.acceptAllStatusBarItem.hide();
            items.rejectAllStatusBarItem.hide();
        }
    }

    /**
     * 更新纠错进度
     */
    public updateCorrectionProgress(editor: vscode.TextEditor, current: number, total: number): void {
        const items = this.getOrCreateStatusBarItems(editor);
        items.correctionStatusBarItem.text = `$(loading~spin) 纠错中...(${current}/${total})`;

        // 确保状态栏项目可见
        items.correctionStatusBarItem.show();

        // 如果是当前活动编辑器，立即显示进度
        if (vscode.window.activeTextEditor?.document.uri.toString() === editor.document.uri.toString()) {
            this.showStatusBarForEditor(editor);
        }
    }

    /**
     * 清理已关闭编辑器的状态栏
     */
    public cleanupClosedEditors(): void {
        const openUris = new Set(
            vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString())
        );

        for (const [uri, items] of this.editorStatusBars.entries()) {
            if (!openUris.has(uri)) {
                // 释放状态栏项目
                items.costStatusBarItem.dispose();
                items.actualCostStatusBarItem.dispose();
                items.correctionStatusBarItem.dispose();
                items.cancelStatusBarItem.dispose();
                items.acceptAllStatusBarItem.dispose();
                items.rejectAllStatusBarItem.dispose();

                // 从映射中移除
                this.editorStatusBars.delete(uri);
            }
        }
    }

    /**
     * 获取所有状态栏项目用于注册到context.subscriptions
     */
    public getAllStatusBarItems(): vscode.StatusBarItem[] {
        const items: vscode.StatusBarItem[] = [];
        for (const editorItems of this.editorStatusBars.values()) {
            items.push(
                editorItems.costStatusBarItem,
                editorItems.actualCostStatusBarItem,
                editorItems.correctionStatusBarItem,
                editorItems.cancelStatusBarItem,
                editorItems.acceptAllStatusBarItem,
                editorItems.rejectAllStatusBarItem
            );
        }
        return items;
    }

    /**
     * 释放所有资源
     */
    public dispose(): void {
        for (const items of this.editorStatusBars.values()) {
            items.costStatusBarItem.dispose();
            items.actualCostStatusBarItem.dispose();
            items.correctionStatusBarItem.dispose();
            items.cancelStatusBarItem.dispose();
            items.acceptAllStatusBarItem.dispose();
            items.rejectAllStatusBarItem.dispose();
        }
        this.editorStatusBars.clear();
    }
}

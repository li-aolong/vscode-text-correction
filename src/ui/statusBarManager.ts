import * as vscode from 'vscode';
import { EditorStateManager } from '../services/editorStateManager';
import { ConfigManager } from '../config/configManager';

/**
 * 单个编辑器的状态栏项目集合
 */
interface EditorStatusBarItems {
    uri: string;
    costStatusBarItem: vscode.StatusBarItem; // 花费信息状态栏项
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
    private configManager: ConfigManager;
    private updateTimeout: NodeJS.Timeout | undefined;
    private isUpdatingProgress: boolean = false; // 标记是否正在更新进度

    constructor(editorStateManager: EditorStateManager, configManager: ConfigManager) {
        this.editorStateManager = editorStateManager;
        this.configManager = configManager;

        // 监听编辑器状态变化
        this.editorStateManager.onDidChangeEditorState(() => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && !this.isUpdatingProgress) {
                this.debouncedUpdateStatusBar(activeEditor);
            }
        });
    }

    /**
     * 防抖的状态栏更新，避免快速切换时的竞态条件
     */
    private debouncedUpdateStatusBar(editor: vscode.TextEditor): void {
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }

        this.updateTimeout = setTimeout(() => {
            // 再次检查是否仍然是当前活动编辑器，且不在更新进度中
            if (vscode.window.activeTextEditor?.document.uri.toString() === editor.document.uri.toString() && !this.isUpdatingProgress) {
                this.updateStatusBarForEditor(editor);
            }
        }, 50);
    }

    /**
     * 获取或创建编辑器的状态栏项目
     */
    private getOrCreateStatusBarItems(editor: vscode.TextEditor): EditorStatusBarItems {
        const uri = editor.document.uri.toString();

        if (!this.editorStatusBars.has(uri)) {
            const items: EditorStatusBarItems = {
                uri,
                costStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5), // 花费信息在最左边
                correctionStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4),
                cancelStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3),
                acceptAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2),
                rejectAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1)
            };

            // 设置花费信息状态栏项的初始状态
            items.costStatusBarItem.text = "";
            items.costStatusBarItem.tooltip = "点击查看详细花费信息";

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
        // 确保只有当前活动编辑器的状态栏可见
        if (vscode.window.activeTextEditor?.document.uri.toString() !== editor.document.uri.toString()) {
            return; // 如果不是当前活动编辑器，不显示状态栏
        }

        // 隐藏所有其他编辑器的状态栏
        this.hideAllStatusBars();

        // 显示当前编辑器的状态栏
        const items = this.getOrCreateStatusBarItems(editor);
        const state = this.editorStateManager.getEditorState(editor);

        items.correctionStatusBarItem.show();

        // 如果正在纠错中，检查是否有进度信息需要恢复显示
        if (state.isCorrectingInProgress) {
            // 如果状态栏文本包含进度信息，直接显示
            if (items.correctionStatusBarItem.text.includes('(') && items.correctionStatusBarItem.text.includes('/')) {
                items.cancelStatusBarItem.show();
                this.updateActionButtonsVisibility(editor, items);
                return; // 直接返回，不调用updateStatusBarForEditor避免覆盖进度
            }
        }

        // 根据编辑器状态决定其他按钮的显示和内容
        this.updateStatusBarForEditor(editor);
    }

    /**
     * 隐藏所有状态栏项目
     */
    private hideAllStatusBars(): void {
        for (const items of this.editorStatusBars.values()) {
            items.costStatusBarItem.hide();
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

        // 更新花费信息状态栏
        this.updateCostStatusBar(editor, items);

        // 更新纠错状态
        if (state.isCorrectingInProgress) {
            items.correctionStatusBarItem.command = undefined; // 禁用命令
            // 如果状态栏文本已经包含进度信息，不要覆盖它
            if (!items.correctionStatusBarItem.text.includes('(') || !items.correctionStatusBarItem.text.includes('/')) {
                items.correctionStatusBarItem.text = "$(loading~spin) 纠错中...";
                items.correctionStatusBarItem.tooltip = "正在进行文本纠错，请稍候...";
            }
            items.cancelStatusBarItem.show();
        } else if (this.editorStateManager.hasChanges(editor)) {
            // 有diff信息时禁用全文纠错按钮
            items.correctionStatusBarItem.command = undefined; // 禁用命令
            items.correctionStatusBarItem.text = "$(check) 纠错完成 (请先处理当前修改)";
            items.correctionStatusBarItem.tooltip = "纠错已完成，请先处理当前的修改建议";
            items.cancelStatusBarItem.hide();
        } else {
            // 没有纠错进行中，也没有待处理的修改
            items.correctionStatusBarItem.text = "$(pencil) 全文纠错";
            items.correctionStatusBarItem.command = 'textCorrection.correctFullText';
            items.correctionStatusBarItem.tooltip = "点击开始全文纠错";
            items.cancelStatusBarItem.hide();
        }

        // 更新操作按钮的可见性
        this.updateActionButtonsVisibility(editor, items);
    }

    /**
     * 更新花费信息状态栏
     */
    private updateCostStatusBar(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        const costInfo = this.editorStateManager.getCostInfo(editor);
        const costText = this.formatCostText(costInfo);
        const detailedCostInfo = this.formatDetailedCostInfo(costInfo);

        // 始终显示花费信息，即使花费为0
        items.costStatusBarItem.text = costText;
        items.costStatusBarItem.tooltip = detailedCostInfo;
        items.costStatusBarItem.show();
    }

    /**
     * 更新纠错进度
     */
    public updateCorrectionProgress(editor: vscode.TextEditor, current: number, total: number): void {
        const editorUri = editor.document.uri.toString();
        const activeUri = vscode.window.activeTextEditor?.document.uri.toString();

        // 设置进度更新标记，防止其他更新干扰
        this.isUpdatingProgress = true;

        const items = this.getOrCreateStatusBarItems(editor);

        // 更新进度显示
        items.correctionStatusBarItem.text = `$(loading~spin) 纠错中...(${current}/${total})`;
        items.correctionStatusBarItem.command = undefined; // 禁用命令

        // 设置详细的进度提示信息
        const remaining = total - current;
        const progressTooltip = `纠错进度详情：
总共段落: ${total}
已纠正段落: ${current}
剩余段落: ${remaining}
进度: ${Math.round((current / total) * 100)}%`;
        items.correctionStatusBarItem.tooltip = progressTooltip;

        // 更新花费信息状态栏
        this.updateCostStatusBar(editor, items);

        // 如果是当前活动编辑器，显示进度
        if (activeUri === editorUri) {
            // 首先隐藏所有其他编辑器的状态栏
            this.hideAllStatusBars();

            // 显示当前编辑器的状态栏
            items.correctionStatusBarItem.show();
            items.cancelStatusBarItem.show();

            // 始终显示花费信息
            items.costStatusBarItem.show();

            // 更新操作按钮的可见性
            this.updateActionButtonsVisibility(editor, items);
        }

        // 延迟重置标记，确保进度更新完成
        setTimeout(() => {
            this.isUpdatingProgress = false;
        }, 100);
    }

    /**
     * 格式化花费信息文本
     */
    private formatCostText(costInfo: any): string {
        // 转换货币单位为符号
        const currencySymbol = costInfo.currency === '元' ? '￥' : '$';

        if (costInfo.totalCost === 0) {
            return `$(credit-card) 已花费: ${currencySymbol} 0`;
        }

        // 根据花费大小选择合适的小数位数
        let cost: string;
        if (costInfo.totalCost >= 1) {
            cost = costInfo.totalCost.toFixed(2); // 大于1元显示2位小数
        } else if (costInfo.totalCost >= 0.01) {
            cost = costInfo.totalCost.toFixed(4); // 大于0.01元显示4位小数
        } else {
            cost = costInfo.totalCost.toFixed(6); // 小于0.01元显示6位小数
        }

        return `$(credit-card) 已花费: ${currencySymbol} ${cost}`;
    }

    /**
     * 格式化详细花费信息（用于tooltip）
     */
    private formatDetailedCostInfo(costInfo: any): string {
        if (costInfo.totalCost === 0) {
            return '暂无花费信息';
        }

        const currencySymbol = costInfo.currency === '元' ? '￥' : '$';
        const inputTokens = costInfo.totalInputTokens;
        const outputTokens = costInfo.totalOutputTokens;
        const totalTokens = inputTokens + outputTokens;

        // 获取配置信息以计算输入和输出花费
        const config = this.configManager.getConfig();
        const inputRate = config.inputTokenPrice / 1_000_000;  // 元/token
        const outputRate = config.outputTokenPrice / 1_000_000;  // 元/token

        // 计算输入和输出花费
        const inputCost = inputTokens * inputRate;
        const outputCost = outputTokens * outputRate;

        return `花费详情：
输入tokens: ${inputTokens}
输出tokens: ${outputTokens}
总tokens: ${totalTokens}
输入花费: ${currencySymbol}${inputCost.toFixed(6)}
输出花费: ${currencySymbol}${outputCost.toFixed(6)}
总计: ${currencySymbol}${costInfo.totalCost.toFixed(6)}`;
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
        // 清理定时器
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }

        for (const items of this.editorStatusBars.values()) {
            items.costStatusBarItem.dispose();
            items.correctionStatusBarItem.dispose();
            items.cancelStatusBarItem.dispose();
            items.acceptAllStatusBarItem.dispose();
            items.rejectAllStatusBarItem.dispose();
        }
        this.editorStatusBars.clear();
    }
}

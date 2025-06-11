import * as vscode from 'vscode';
import { EditorStateManager } from '../services/editorStateManager';
import { ConfigManager } from '../config/configManager';
import { TimeStatisticsService } from '../services/timeStatisticsService';

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
    prevChangeStatusBarItem: vscode.StatusBarItem; // 上一个修改按钮
    nextChangeStatusBarItem: vscode.StatusBarItem; // 下一个修改按钮
    navigationProgressStatusBarItem: vscode.StatusBarItem; // 导航进度显示
}

/**
 * 管理每个编辑器独立的状态栏项目
 */
export class StatusBarManager {
    private editorStatusBars: Map<string, EditorStatusBarItems> = new Map();
    private editorStateManager: EditorStateManager;
    private configManager: ConfigManager;
    private timeStatisticsService: TimeStatisticsService;
    private updateTimeout: NodeJS.Timeout | undefined;
    private isUpdatingProgress: boolean = false; // 标记是否正在更新进度

    constructor(
        editorStateManager: EditorStateManager, 
        configManager: ConfigManager,
        timeStatisticsService: TimeStatisticsService
    ) {
        this.editorStateManager = editorStateManager;
        this.configManager = configManager;
        this.timeStatisticsService = timeStatisticsService;

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
                costStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8), // 花费信息在最左边
                correctionStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7),
                cancelStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 6),
                acceptAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5),
                rejectAllStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4),
                prevChangeStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3),
                nextChangeStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2),
                navigationProgressStatusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1)
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

            // 设置上一个修改按钮
            items.prevChangeStatusBarItem.text = "$(arrow-left) 上一个";
            items.prevChangeStatusBarItem.command = 'textCorrection.prevChange';
            items.prevChangeStatusBarItem.tooltip = "上一个修改";
            items.prevChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.prevChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); // 黄色

            // 设置下一个修改按钮
            items.nextChangeStatusBarItem.text = "下一个 $(arrow-right)";
            items.nextChangeStatusBarItem.command = 'textCorrection.nextChange';
            items.nextChangeStatusBarItem.tooltip = "下一个修改";
            items.nextChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.nextChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); // 黄色

            // 设置导航进度显示
            items.navigationProgressStatusBarItem.text = "$(location)";
            items.navigationProgressStatusBarItem.tooltip = "导航进度";

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
            items.prevChangeStatusBarItem.hide();
            items.nextChangeStatusBarItem.hide();
            items.navigationProgressStatusBarItem.hide();
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
            
            // 确保导航按钮的背景色正确设置
            items.prevChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.prevChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            items.nextChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.nextChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (this.editorStateManager.hasChanges(editor)) {
            // 有diff信息时禁用全文纠错按钮
            items.correctionStatusBarItem.command = undefined; // 禁用命令
            items.correctionStatusBarItem.text = "$(check) 纠错完成";
            items.correctionStatusBarItem.tooltip = "纠错已完成，请先处理当前的修改建议";
            items.cancelStatusBarItem.hide();
            
            // 确保导航按钮的背景色正确设置
            items.prevChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.prevChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            items.nextChangeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
            items.nextChangeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
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

        // 获取时间统计信息
        const timeStats = this.timeStatisticsService.getTimeStatistics(editor);
        
        // 使用等宽字体格式化函数实现右对齐
        const formatLine = (label: string, value: string, totalWidth: number = 18) => {
            const spaces = ' '.repeat(Math.max(1, totalWidth - label.length - value.length));
            return `${label}${spaces}${value}`;
        };

        let progressTooltip = `**纠错进度详情：**\n`;
        progressTooltip += formatLine('总共段落:', total.toString()) + '\n';
        progressTooltip += formatLine('已纠正段落:', current.toString()) + '\n';
        progressTooltip += formatLine('剩余段落:', (total - current).toString()) + '\n';
        progressTooltip += formatLine('进度:', `${Math.round((current / total) * 100)}%`);

        // 添加时间统计信息到tooltip
        if (timeStats) {
            progressTooltip += `\n\n${this.timeStatisticsService.getDetailedTimeInfo(editor)}`;
        }

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

        // 使用等宽字体格式化函数实现右对齐
        const formatLine = (label: string, value: string, totalWidth: number = 22) => {
            const spaces = ' '.repeat(Math.max(1, totalWidth - label.length - value.length));
            return `${label}${spaces}${value}`;
        };

        let costDetails = `**花费详情：**\n`;
        costDetails += formatLine('输入tokens:', inputTokens.toString()) + '\n';
        costDetails += formatLine('输出tokens:', outputTokens.toString()) + '\n';
        costDetails += formatLine('总tokens:', totalTokens.toString()) + '\n';
        costDetails += formatLine('输入花费:', `${currencySymbol}${inputCost.toFixed(6)}`) + '\n';
        costDetails += formatLine('输出花费:', `${currencySymbol}${outputCost.toFixed(6)}`) + '\n';
        costDetails += formatLine('总计:', `${currencySymbol}${costInfo.totalCost.toFixed(6)}`);

        // 如果有当前编辑器，尝试添加时间统计信息
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const timeStats = this.timeStatisticsService.getTimeStatistics(activeEditor);
            if (timeStats && timeStats.totalElapsedTime > 0) {
                costDetails += `\n\n${this.timeStatisticsService.getDetailedTimeInfo(activeEditor)}`;
            }
        }

        return costDetails;
    }

    /**
     * 更新操作按钮的可见性
     */
    private updateActionButtonsVisibility(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        if (this.editorStateManager.hasChanges(editor)) {
            items.acceptAllStatusBarItem.show();
            items.rejectAllStatusBarItem.show();
            
            // 显示导航按钮
            items.prevChangeStatusBarItem.show();
            items.nextChangeStatusBarItem.show();
            items.navigationProgressStatusBarItem.show();
            
            // 更新导航进度
            this.updateNavigationProgress(editor, items);
        } else {
            items.acceptAllStatusBarItem.hide();
            items.rejectAllStatusBarItem.hide();
            
            // 隐藏导航按钮
            items.prevChangeStatusBarItem.hide();
            items.nextChangeStatusBarItem.hide();
            items.navigationProgressStatusBarItem.hide();
        }
    }

    /**
     * 更新导航进度显示
     */
    private updateNavigationProgress(editor: vscode.TextEditor, items: EditorStatusBarItems): void {
        const state = this.editorStateManager.getEditorState(editor);
        const changes = state.changes;
        
        if (changes.length > 0) {
            const currentIndex = state.currentChangeIndex;
            const total = changes.length;
            
            // 确保currentIndex在有效范围内
            const validIndex = Math.min(Math.max(0, currentIndex), total - 1);
            const current = validIndex + 1; // 从0开始的索引转为从1开始的计数
            
            // 更新导航进度文本
            items.navigationProgressStatusBarItem.text = `$(location) ${current}/${total}`;
            
            // 更新提示信息
            items.navigationProgressStatusBarItem.tooltip = `当前位置: ${current}/${total}`;
            
            // 确保背景色一致
        } else {
            items.navigationProgressStatusBarItem.text = "$(location)";
            items.navigationProgressStatusBarItem.hide();
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
                items.prevChangeStatusBarItem.dispose();
                items.nextChangeStatusBarItem.dispose();
                items.navigationProgressStatusBarItem.dispose();

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
                editorItems.rejectAllStatusBarItem,
                editorItems.prevChangeStatusBarItem,
                editorItems.nextChangeStatusBarItem,
                editorItems.navigationProgressStatusBarItem
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
            items.prevChangeStatusBarItem.dispose();
            items.nextChangeStatusBarItem.dispose();
            items.navigationProgressStatusBarItem.dispose();
        }
        this.editorStatusBars.clear();
    }
}

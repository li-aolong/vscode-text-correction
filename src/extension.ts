import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { CostCalculator } from './services/costCalculator';
import { CorrectionService } from './services/correctionService';
import { DiffManager } from './diff/diffManager';

let statusBarItem: vscode.StatusBarItem;
let correctionStatusBarItem: vscode.StatusBarItem;
let cancelStatusBarItem: vscode.StatusBarItem;
let configManager: ConfigManager;
let costCalculator: CostCalculator;
let correctionService: CorrectionService;
let diffManager: DiffManager;
let isCorrectingInProgress = false;

export function activate(context: vscode.ExtensionContext) {
    // 初始化服务
    configManager = new ConfigManager();
    costCalculator = new CostCalculator(configManager);
    correctionService = new CorrectionService(configManager);
    diffManager = new DiffManager();

    // 设置服务间的双向关联
    correctionService.setDiffManager(diffManager);
    diffManager.setCorrectionService(correctionService);

    // 创建状态栏项目
    createStatusBarItems();

    // 注册命令
    registerCommands(context);

    // 注册事件监听器
    registerEventListeners(context);

    // 初始更新状态栏
    updateStatusBar();
}

function createStatusBarItems() {
    // 费用预估状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -5);
    statusBarItem.show();

    // 纠错按钮状态栏
    correctionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -10);
    correctionStatusBarItem.text = "$(pencil) 全文纠错";
    correctionStatusBarItem.command = 'textCorrection.correctFullText';
    correctionStatusBarItem.show();

    // 取消按钮状态栏（初始隐藏）
    cancelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -11);
    cancelStatusBarItem.text = "$(x)";
    cancelStatusBarItem.command = 'textCorrection.cancelCorrection';
    cancelStatusBarItem.tooltip = "取消纠错";
}

function registerCommands(context: vscode.ExtensionContext) {
    // 全文纠错命令
    const correctFullTextCommand = vscode.commands.registerCommand('textCorrection.correctFullText', async () => {
        if (isCorrectingInProgress) {
            return; // 正在纠错时不响应点击
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有打开的编辑器');
            return;
        }

        isCorrectingInProgress = true;
        correctionStatusBarItem.command = undefined; // 禁用命令
        correctionStatusBarItem.text = "$(loading~spin) 纠错中...";
        cancelStatusBarItem.show();
        
        try {
            await correctionService.correctFullText(editor, (current: number, total: number) => {
                // 进度回调
                correctionStatusBarItem.text = `$(loading~spin) 纠错中...(${current}/${total})`;
            });
        } catch (error) {
            vscode.window.showErrorMessage(`纠错失败: ${error}`);
        } finally {
            isCorrectingInProgress = false;
            correctionStatusBarItem.text = "$(pencil) 全文纠错";
            correctionStatusBarItem.command = 'textCorrection.correctFullText';
            cancelStatusBarItem.hide();
        }
    });

    // 取消纠错命令
    const cancelCorrectionCommand = vscode.commands.registerCommand('textCorrection.cancelCorrection', () => {
        if (isCorrectingInProgress) {
            correctionService.cancelCorrection();
            isCorrectingInProgress = false;
            correctionStatusBarItem.text = "$(pencil) 全文纠错";
            correctionStatusBarItem.command = 'textCorrection.correctFullText';
            cancelStatusBarItem.hide();
        }
    });

    // 差异管理命令
    const acceptAllCommand = vscode.commands.registerCommand('textCorrection.acceptAllChanges', () => {
        diffManager.acceptAllChanges();
    });

    const rejectAllCommand = vscode.commands.registerCommand('textCorrection.rejectAllChanges', () => {
        diffManager.rejectAllChanges();
    });

    const nextChangeCommand = vscode.commands.registerCommand('textCorrection.nextChange', () => {
        diffManager.goToNextChange();
    });

    const previousChangeCommand = vscode.commands.registerCommand('textCorrection.previousChange', () => {
        diffManager.goToPreviousChange();
    });

    context.subscriptions.push(
        correctFullTextCommand,
        cancelCorrectionCommand,
        acceptAllCommand,
        rejectAllCommand,
        nextChangeCommand,
        previousChangeCommand,
        statusBarItem,
        correctionStatusBarItem,
        cancelStatusBarItem,
        diffManager
    );
}

function registerEventListeners(context: vscode.ExtensionContext) {
    // 监听文本选择变化
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(() => {
        updateStatusBar();
    });

    // 监听活动编辑器变化
    const activeEditorChangeListener = vscode.window.onDidChangeActiveTextEditor(() => {
        updateStatusBar();
    });

    // 监听配置变化
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('textCorrection')) {
            configManager.reloadConfig();
            updateStatusBar();
        }
    });

    context.subscriptions.push(
        selectionChangeListener,
        activeEditorChangeListener,
        configChangeListener
    );
}

function updateStatusBar() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        statusBarItem.text = "费用预估: 无文档";
        return;
    }

    const fullText = editor.document.getText();
    const fullTextCost = costCalculator.estimateCost(fullText);
    
    const selection = editor.selection;
    let statusText = `全文纠错预估: ${fullTextCost}`;
    
    if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        const selectedCost = costCalculator.estimateCost(selectedText);
        statusText += ` | 选中内容: ${selectedCost}`;
    }

    statusBarItem.text = statusText;
}

export function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
    if (correctionStatusBarItem) {
        correctionStatusBarItem.dispose();
    }
    if (cancelStatusBarItem) {
        cancelStatusBarItem.dispose();
    }
    if (diffManager) {
        diffManager.dispose();
    }
}

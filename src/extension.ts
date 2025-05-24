import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { CostCalculator } from './services/costCalculator';
import { CorrectionService, ParagraphIdentifier, ParagraphStatus } from './services/correctionService';
import { DiffManager } from './diff/diffManager';
import { ParagraphCodeLensProvider } from './providers/paragraphCodeLensProvider';

let statusBarItem: vscode.StatusBarItem;
let correctionStatusBarItem: vscode.StatusBarItem;
let cancelStatusBarItem: vscode.StatusBarItem;
let acceptAllStatusBarItem: vscode.StatusBarItem;
let rejectAllStatusBarItem: vscode.StatusBarItem;
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

    // 注册段落 CodeLens 提供程序
    const paragraphCodeLensProvider = new ParagraphCodeLensProvider(correctionService);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { scheme: 'file', language: '*' }, // 适用于所有文件类型，可以根据需要调整
            paragraphCodeLensProvider
        )
    );

    // 注册事件监听器
    registerEventListeners(context);

    // 初始更新状态栏
    updateStatusBar();
    updateCorrectionActionButtonsVisibility(); // 更新新增按钮的可见性
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

    // 接受全部按钮状态栏（初始隐藏）
    acceptAllStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -12);
    acceptAllStatusBarItem.text = "$(check-all) 全接受";
    acceptAllStatusBarItem.command = 'textCorrection.acceptAllChanges';
    acceptAllStatusBarItem.tooltip = "接受所有更改";
    acceptAllStatusBarItem.hide();

    // 拒绝全部按钮状态栏（初始隐藏）
    rejectAllStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -13);
    rejectAllStatusBarItem.text = "$(close-all) 全拒绝";
    rejectAllStatusBarItem.command = 'textCorrection.rejectAllChanges';
    rejectAllStatusBarItem.tooltip = "拒绝所有更改";
    rejectAllStatusBarItem.hide();
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
            updateCorrectionActionButtonsVisibility(); // 更新“接受全部”/“拒绝全部”按钮的可见性
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
    const acceptAllCommand = vscode.commands.registerCommand('textCorrection.acceptAllChanges', async () => {
        await diffManager.acceptAllChanges();
        correctionService.updateAllParagraphsStatus(ParagraphStatus.Accepted);
        updateCorrectionActionButtonsVisibility();
    });

    const rejectAllCommand = vscode.commands.registerCommand('textCorrection.rejectAllChanges', async () => {
        await diffManager.rejectAllChanges();
        correctionService.updateAllParagraphsStatus(ParagraphStatus.Rejected);
        updateCorrectionActionButtonsVisibility();
    });

    const nextChangeCommand = vscode.commands.registerCommand('textCorrection.nextChange', () => {
        diffManager.goToNextChange();
    });

    const previousChangeCommand = vscode.commands.registerCommand('textCorrection.previousChange', () => {
        diffManager.goToPreviousChange();
    });

    // 段落接受命令
    const acceptParagraphCommand = vscode.commands.registerCommand('textCorrection.acceptParagraph', (identifier: ParagraphIdentifier) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            correctionService.acceptParagraph(identifier, editor);
            updateCorrectionActionButtonsVisibility(); // 更新按钮可见性
        } else {
            vscode.window.showErrorMessage('无法接受段落：没有活动的编辑器。');
        }
    });

    // 段落拒绝命令
    const rejectParagraphCommand = vscode.commands.registerCommand('textCorrection.rejectParagraph', (identifier: ParagraphIdentifier) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            correctionService.rejectParagraph(identifier, editor);
            updateCorrectionActionButtonsVisibility(); // 更新按钮可见性
        } else {
            vscode.window.showErrorMessage('无法拒绝段落：没有活动的编辑器。');
        }
    });

    context.subscriptions.push(
        correctFullTextCommand,
        cancelCorrectionCommand,
        acceptAllCommand,
        rejectAllCommand,
        nextChangeCommand,
        previousChangeCommand,
        acceptParagraphCommand, // 新增
        rejectParagraphCommand, // 新增
        statusBarItem,
        correctionStatusBarItem,
        cancelStatusBarItem,
        acceptAllStatusBarItem, // 新增
        rejectAllStatusBarItem, // 新增
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

function updateCorrectionActionButtonsVisibility() {
    if (diffManager && diffManager.hasChanges()) {
        acceptAllStatusBarItem.show();
        rejectAllStatusBarItem.show();
    } else {
        acceptAllStatusBarItem.hide();
        rejectAllStatusBarItem.hide();
    }
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
    if (acceptAllStatusBarItem) {
        acceptAllStatusBarItem.dispose();
    }
    if (rejectAllStatusBarItem) {
        rejectAllStatusBarItem.dispose();
    }
    if (diffManager) {
        diffManager.dispose();
    }
}

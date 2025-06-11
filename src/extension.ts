import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { CorrectionService } from './services/correctionService';
import { DiffManager } from './diff/diffManager';
import { ParagraphCodeLensProvider } from './providers/paragraphCodeLensProvider';
import { EditorStateManager } from './services/editorStateManager';
import { StatusBarManager } from './ui/statusBarManager';
import { TimeStatisticsService } from './services/timeStatisticsService';

let configManager: ConfigManager;
let correctionService: CorrectionService;
let diffManager: DiffManager;
let editorStateManager: EditorStateManager;
let statusBarManager: StatusBarManager;
let timeStatisticsService: TimeStatisticsService;

export function activate(context: vscode.ExtensionContext) {
    // 初始化服务
    configManager = new ConfigManager();
    editorStateManager = new EditorStateManager();
    timeStatisticsService = new TimeStatisticsService();
    statusBarManager = new StatusBarManager(editorStateManager, configManager, timeStatisticsService);
    correctionService = new CorrectionService(configManager, editorStateManager, timeStatisticsService);
    diffManager = new DiffManager(editorStateManager);

    // 设置服务间的双向关联
    correctionService.setDiffManager(diffManager);
    diffManager.setCorrectionService(correctionService);

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
    updateStatusBarForCurrentEditor();
}



function registerCommands(context: vscode.ExtensionContext) {
    // 全文纠错命令
    const correctFullTextCommand = vscode.commands.registerCommand('textCorrection.correctFullText', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有打开的编辑器');
            return;
        }

        if (editorStateManager.isCorrectingInProgress(editor)) {
            return; // 正在纠错时不响应点击
        }

        editorStateManager.updateEditorState(editor, { isCorrectingInProgress: true });
        updateStatusBarForCurrentEditor();

        try {
            await correctionService.correctFullText(editor, (current: number, total: number) => {
                // 进度回调 - 立即更新状态栏
                statusBarManager.updateCorrectionProgress(editor, current, total);
            });
        } catch (error) {
            vscode.window.showErrorMessage(`纠错失败: ${error}`);
        } finally {
            editorStateManager.updateEditorState(editor, { isCorrectingInProgress: false });
            updateStatusBarForCurrentEditor();
        }
    });

    // 取消纠错命令
    const cancelCorrectionCommand = vscode.commands.registerCommand('textCorrection.cancelCorrection', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editorStateManager.isCorrectingInProgress(editor)) {
            // 标记当前编辑器的纠错为已取消
            editorStateManager.updateEditorState(editor, {
                isCancelled: true,
                isCorrectingInProgress: false
            });
            updateStatusBarForCurrentEditor();
            vscode.window.showInformationMessage('纠错操作已取消');
        }
    });

    // 选中文本纠错命令
    const correctSelectedTextCommand = vscode.commands.registerCommand('textCorrection.correctSelectedText', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有打开的编辑器');
            return;
        }

        if (!correctionService.hasSelection(editor)) {
            vscode.window.showInformationMessage('请先选择要纠正的文本');
            return;
        }

        try {
            await correctionService.correctSelectedText(editor);
        } catch (error) {
            vscode.window.showErrorMessage(`选中文本纠错失败: ${error}`);
        } finally {
            updateStatusBarForCurrentEditor();
        }
    });

    // 差异管理命令
    const acceptAllCommand = vscode.commands.registerCommand('textCorrection.acceptAllChanges', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            // 使用CorrectionService的智能全部接受方法
            await correctionService.acceptAllPendingParagraphs(editor);
            // 强制更新状态栏
            setTimeout(() => updateStatusBarForCurrentEditor(), 100);
        }
    });

    const rejectAllCommand = vscode.commands.registerCommand('textCorrection.rejectAllChanges', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            // 使用CorrectionService的智能全部拒绝方法
            await correctionService.rejectAllPendingParagraphs(editor);
            // 强制更新状态栏
            setTimeout(() => updateStatusBarForCurrentEditor(), 100);
        }
    });

    const nextChangeCommand = vscode.commands.registerCommand('textCorrection.nextChange', () => {
        diffManager.goToNextChange();
    });

    const previousChangeCommand = vscode.commands.registerCommand('textCorrection.prevChange', () => {
        diffManager.goToPreviousChange();
    });

    // 获取 paragraphActionService 实例
    const paragraphActionService = (correctionService as any).paragraphActionService;
    
    // 段落接受命令
    const acceptParagraphCommand = vscode.commands.registerCommand('textCorrection.acceptParagraph', (paragraphId: string) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            paragraphActionService.acceptParagraph(paragraphId, editor);
            updateStatusBarForCurrentEditor(); // 更新按钮可见性
        } else {
            vscode.window.showErrorMessage('无法接受段落：没有活动的编辑器。');
        }
    });

    // 段落拒绝命令
    const rejectParagraphCommand = vscode.commands.registerCommand('textCorrection.rejectParagraph', (paragraphId: string) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            paragraphActionService.rejectParagraph(paragraphId, editor);
            updateStatusBarForCurrentEditor(); // 更新按钮可见性
        } else {
            vscode.window.showErrorMessage('无法拒绝段落：没有活动的编辑器。');
        }
    });

    // 关闭错误提示命令
    const dismissErrorCommand = vscode.commands.registerCommand('textCorrection.dismissError', async (paragraphId: string) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await paragraphActionService.dismissError(paragraphId, editor);
            updateStatusBarForCurrentEditor();
        }
    });    // 更新状态栏命令
    const updateStatusBarCommand = vscode.commands.registerCommand('textCorrection.updateStatusBar', () => {
        updateStatusBarForCurrentEditor();
    });

    // 取消"无需纠正"状态命令
    const dismissNoCorrectionCommand = vscode.commands.registerCommand('textCorrection.dismissNoCorrection', (paragraphId: string) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const paragraphActionService = (correctionService as any).paragraphActionService;
            paragraphActionService.dismissNoCorrection(paragraphId, editor);
            updateStatusBarForCurrentEditor();
        }
    });

    context.subscriptions.push(
        correctFullTextCommand,
        cancelCorrectionCommand,
        correctSelectedTextCommand,
        acceptAllCommand,
        rejectAllCommand,
        nextChangeCommand,
        previousChangeCommand,
        acceptParagraphCommand,
        rejectParagraphCommand,
        dismissErrorCommand,
        dismissNoCorrectionCommand,
        updateStatusBarCommand,
        statusBarManager,
        diffManager
    );
}

function registerEventListeners(context: vscode.ExtensionContext) {
    // 监听文本选择变化
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(() => {
        updateStatusBarForCurrentEditor();
    });

    // 监听活动编辑器变化
    const activeEditorChangeListener = vscode.window.onDidChangeActiveTextEditor(() => {
        updateStatusBarForCurrentEditor();
        editorStateManager.cleanupClosedEditors();
        statusBarManager.cleanupClosedEditors();
        diffManager.cleanupClosedEditors();
    });

    // 监听配置变化
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('textCorrection')) {
            configManager.reloadConfig();
            updateStatusBarForCurrentEditor();
        }
    });

    // 监听段落纠错状态变化，更新CodeLens和状态栏
    const paragraphCorrectionsChangeListener = correctionService.onDidChangeParagraphCorrections(() => {
        // 触发CodeLens刷新
        vscode.commands.executeCommand('vscode.executeCodeLensProvider', vscode.window.activeTextEditor?.document.uri);

        // 延迟更新状态栏，但只在不是纠错进行中时更新，避免覆盖进度显示
        setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editorStateManager.isCorrectingInProgress(editor)) {
                updateStatusBarForCurrentEditor();
            }
        }, 50);
    });

    context.subscriptions.push(
        selectionChangeListener,
        activeEditorChangeListener,
        configChangeListener,
        paragraphCorrectionsChangeListener
    );
}

function updateStatusBarForCurrentEditor() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        statusBarManager.showStatusBarForEditor(editor);
        // 恢复当前编辑器的装饰
        restoreDecorationsForEditor(editor);
    }
}

function restoreDecorationsForEditor(editor: vscode.TextEditor) {
    // 恢复diff装饰
    const changes = editorStateManager.getChanges(editor);

    if (changes.length > 0) {
        // 强制恢复装饰，确保显示正确
        editorStateManager.markDecorationsNeedUpdate(editor);
        diffManager.updateDecorationsForEditor(editor);
    }
}

export function deactivate() {
    if (statusBarManager) {
        statusBarManager.dispose();
    }
    if (diffManager) {
        diffManager.dispose();
    }
    if (editorStateManager) {
        editorStateManager.dispose();
    }
}

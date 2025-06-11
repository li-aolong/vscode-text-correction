import * as vscode from 'vscode';
import { CorrectionService } from '../services/correctionService';
import { ParagraphStatus } from '../models/paragraphModel';

export class ParagraphCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private noCorrectionsTimers: Map<string, NodeJS.Timeout> = new Map(); // 管理自动消失的计时器

    constructor(private correctionService: CorrectionService) {
        // 监听 CorrectionService 中段落纠正状态的变化
        // 确保 onDidChangeParagraphCorrections 事件存在于 CorrectionService 中
        if (this.correctionService.onDidChangeParagraphCorrections) {
            this.correctionService.onDidChangeParagraphCorrections(() => {
                this._onDidChangeCodeLenses.fire();
            });
        } else {
            console.warn('CorrectionService.onDidChangeParagraphCorrections is not available.');
        }
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];

        // 获取当前文档对应的编辑器
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
        if (!editor) {
            return lenses;
        }

        // 使用新的方法获取段落
        const docParagraphs = this.correctionService.getDocumentParagraphs(editor);
        if (!docParagraphs || !docParagraphs.paragraphs) {
            console.warn('无法获取文档段落数据');
            return lenses;
        }
        const paragraphs = docParagraphs.paragraphs;

        for (const paragraph of paragraphs) {
            // 创建段落首行的范围
            const startLine = paragraph.startLine;
            const range = new vscode.Range(startLine, 0, startLine, 0); // CodeLens 放在段落首行

            if (paragraph.status === ParagraphStatus.Processing && paragraph.id) {
                // 正在处理中：显示转圈图标
                const processingCommand: vscode.Command = {
                    title: "$(loading~spin) 正在纠错中...",
                    command: "", // 空命令，不可点击
                    arguments: []
                };
                lenses.push(new vscode.CodeLens(range, processingCommand));
            } else if (paragraph.status === ParagraphStatus.Pending && paragraph.id) {
                // 待处理：显示接受/拒绝按钮
                const acceptCommand: vscode.Command = {
                    title: "✅ 接受此段落",
                    command: "textCorrection.acceptParagraph",
                    arguments: [paragraph.id] // 传递段落ID
                };
                lenses.push(new vscode.CodeLens(range, acceptCommand));

                const rejectCommand: vscode.Command = {
                    title: "❌ 拒绝此段落",
                    command: "textCorrection.rejectParagraph",
                    arguments: [paragraph.id] // 传递段落ID
                };
                lenses.push(new vscode.CodeLens(range, rejectCommand));
            } else if (paragraph.status === ParagraphStatus.NoCorrection && paragraph.id) {
                // 无需纠正：显示信息图标，可点击消失
                const noCorretionCommand: vscode.Command = {
                    title: "ℹ️ 无需纠正",
                    command: "textCorrection.dismissNoCorrection",
                    arguments: [paragraph.id] // 传递段落ID用于消失
                };
                lenses.push(new vscode.CodeLens(range, noCorretionCommand));
                
                // 设置3秒后自动消失
                this.scheduleAutoHide(paragraph.id);
            } else if (paragraph.status === ParagraphStatus.Error && paragraph.id) {
                // 为错误状态的段落显示简化的错误信息
                const errorCommand: vscode.Command = {
                    title: `❗ 纠错失败`,
                    command: "textCorrection.dismissError",
                    arguments: [paragraph.id] // 只传递段落ID用于关闭
                };
                lenses.push(new vscode.CodeLens(range, errorCommand));
            }
        }
        return lenses;
    }

    public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        return codeLens;
    }

    /**
     * 设置段落的自动隐藏计时器
     */
    private scheduleAutoHide(paragraphId: string): void {
        // 清除之前的计时器（如果存在）
        const existingTimer = this.noCorrectionsTimers.get(paragraphId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // 设置新的计时器，3秒后自动隐藏
        const timer = setTimeout(() => {
            this.hideNoCorrection(paragraphId);
            this.noCorrectionsTimers.delete(paragraphId);
        }, 3000);

        this.noCorrectionsTimers.set(paragraphId, timer);
    }

    /**
     * 隐藏无需纠正的信息
     */
    private hideNoCorrection(paragraphId: string): void {
        // 通过 CorrectionService 来更新段落状态
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return;
        }

        const docParagraphs = this.correctionService.getDocumentParagraphs(activeEditor);
        if (!docParagraphs) {
            return;
        }

        const paragraph = docParagraphs.paragraphs.find(p => p.id === paragraphId);
        if (paragraph && paragraph.status === ParagraphStatus.NoCorrection) {
            // 将状态改为 Rejected，这样就不会再显示任何 CodeLens
            paragraph.status = ParagraphStatus.Rejected;
            
            // 触发更新
            this._onDidChangeCodeLenses.fire();
        }
    }

    /**
     * 清理资源
     */
    public dispose(): void {
        // 清理所有计时器
        for (const timer of this.noCorrectionsTimers.values()) {
            clearTimeout(timer);
        }
        this.noCorrectionsTimers.clear();
        this._onDidChangeCodeLenses.dispose();
    }
}

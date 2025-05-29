import * as vscode from 'vscode';
import { CorrectionService } from '../services/correctionService';
import { ParagraphStatus } from '../models/paragraphModel';

export class ParagraphCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

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

            if (paragraph.status === ParagraphStatus.Pending && paragraph.id) {
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
}

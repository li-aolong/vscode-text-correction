import * as vscode from 'vscode';
import { CorrectionService, ParagraphIdentifier, ParagraphStatus } from '../services/correctionService';

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

        // 确保 getParagraphCorrections 方法存在于 CorrectionService 中
        if (!this.correctionService.getParagraphCorrections) {
            console.warn('CorrectionService.getParagraphCorrections is not available.');
            return lenses;
        }
        const paragraphCorrections = this.correctionService.getParagraphCorrections(editor);

        for (const pc of paragraphCorrections) {
            const range = new vscode.Range(pc.range.start.line, 0, pc.range.start.line, 0); // CodeLens 放在段落首行

            if (pc.status === ParagraphStatus.Pending && pc.id) {
                const acceptCommand: vscode.Command = {
                    title: "✅ 接受此段落",
                    command: "textCorrection.acceptParagraph",
                    arguments: [pc.id] // 传递 ParagraphIdentifier
                };
                lenses.push(new vscode.CodeLens(range, acceptCommand));

                const rejectCommand: vscode.Command = {
                    title: "❌ 拒绝此段落",
                    command: "textCorrection.rejectParagraph",
                    arguments: [pc.id] // 传递 ParagraphIdentifier
                };
                lenses.push(new vscode.CodeLens(range, rejectCommand));
            } else if (pc.status === ParagraphStatus.Error && pc.id) {
                // 为错误状态的段落显示简化的错误信息
                const errorCommand: vscode.Command = {
                    title: `❗ 纠错失败`,
                    command: "textCorrection.dismissError",
                    arguments: [pc.id] // 只传递段落ID用于关闭
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

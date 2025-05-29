import * as vscode from 'vscode';
import { ParagraphModel, ParagraphStatus, DocumentParagraphs } from '../models/paragraphModel';
import { v4 as uuidv4 } from 'uuid';

/**
 * 文本处理服务 - 负责文本分段和相似度计算
 */
export class TextProcessingService {
    /**
     * 将文本分割成段落并创建文档段落集合
     * 只在初始化时调用一次，后续不再重新分割
     */
    public createDocumentParagraphs(text: string): DocumentParagraphs {
        // 标准化换行符：将\r\n和\r都转换为\n
        const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalizedText.split('\n');
        const paragraphs: ParagraphModel[] = [];

        let currentParagraph = '';
        let startLine = 0;
        let emptyLineCount = 0;
        let lastNonEmptyLineIndex = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim() === '') {
                // 空行处理
                emptyLineCount++;
                if (currentParagraph.trim()) {
                    // 创建新的段落模型
                    const endLine = i - emptyLineCount;
                    const range = new vscode.Range(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(endLine, lines[endLine].length)
                    );

                    paragraphs.push({
                        id: uuidv4(),
                        originalContent: currentParagraph,
                        correctedContent: null,
                        startLine: startLine,
                        startLineNumber: startLine, // 初始化 startLineNumber
                        endLine: endLine,
                        range: range,
                        status: ParagraphStatus.Rejected, // 初始状态设为Rejected，表示使用原始内容
                        trailingEmptyLines: emptyLineCount
                    });

                    currentParagraph = '';
                    lastNonEmptyLineIndex = i - 1;
                }
                startLine = i + 1;
            } else {
                // 非空行处理
                if (currentParagraph === '') {
                    startLine = i;
                    emptyLineCount = 0;
                }
                // 保留段落内的换行符
                currentParagraph += (currentParagraph ? '\n' : '') + line;
                lastNonEmptyLineIndex = i;
            }
        }

        // 处理最后一个段落
        if (currentParagraph.trim()) {
            const endLine = lines.length - 1;
            const range = new vscode.Range(
                new vscode.Position(startLine, 0),
                new vscode.Position(endLine, lines[endLine].length)
            );

            paragraphs.push({
                id: uuidv4(),
                originalContent: currentParagraph,
                correctedContent: null,
                startLine: startLine,
                startLineNumber: startLine, // 初始化 startLineNumber
                endLine: endLine,
                range: range,
                status: ParagraphStatus.Pending,
                trailingEmptyLines: lines.length - 1 - lastNonEmptyLineIndex
            });
        }

        // 计算文档末尾的空行数量
        const trailingEmptyLines = lines.length - 1 - lastNonEmptyLineIndex;

        return {
            originalDocumentContent: text,
            paragraphs: paragraphs,
            trailingEmptyLines: trailingEmptyLines
        };
    }
   
    /**
     * 更新段落范围
     * 当段落内容变化时，更新其在文档中的范围
     */
    public updateParagraphRange(paragraph: ParagraphModel): vscode.Range {
        // 使用startLineNumber而非startLine，因为startLineNumber会在段落操作中被更新
        const startLine = paragraph.startLineNumber !== undefined ? paragraph.startLineNumber : paragraph.startLine;
        const content = paragraph.correctedContent || paragraph.originalContent;
        const lines = content.split('\n');
        
        // 计算段落结束行
        const endLine = startLine + lines.length - 1;
        
        // 更新段落的范围
        const newRange = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, lines[lines.length - 1].length)
        );
        
        // 更新段落的其他属性
        paragraph.startLine = startLine;
        paragraph.endLine = endLine;
        
        return newRange;
    }

}

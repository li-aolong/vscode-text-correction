import * as vscode from 'vscode';

/**
 * 段落模型 - 存储段落的详细信息
 */
export interface ParagraphModel {
    /** 段落ID */
    id: string;
    /** 段落原始内容 */
    originalContent: string;
    /** 段落纠正后的内容 */
    correctedContent: string | null;
    /** 段落在文档中的起始行 (静态，初始解析时确定) */
    startLine: number;
    /** (动态计算的) 段落在文档中的当前起始行，主要用于批量操作中行号的动态调整 */
    startLineNumber: number;
    /** 段落在文档中的结束行 */
    endLine: number;
    /** 段落在文档中的范围 */
    range: vscode.Range;
    /** 段落状态 */
    status: ParagraphStatus;
    /** 段落后面的空行数量 */
    trailingEmptyLines: number;
    /** 错误信息（如果有） */
    error?: string;
}

/**
 * 段落状态枚举
 */
export enum ParagraphStatus {
    /** 正在处理中 */
    Processing = 'processing',
    /** 待处理 */
    Pending = 'pending',
    /** 已接受 */
    Accepted = 'accepted',
    /** 已拒绝 */
    Rejected = 'rejected',
    /** 处理出错 */
    Error = 'error'
}

/**
 * 文档段落集合 - 存储整个文档的段落信息
 */
export interface DocumentParagraphs {
    /** 原始文档内容 */
    originalDocumentContent: string;
    /** 所有段落 */
    paragraphs: ParagraphModel[];
    /** 文档最后的空行数量 */
    trailingEmptyLines: number;
}

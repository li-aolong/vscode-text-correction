import * as vscode from 'vscode';
import { DiffManager, ChangeInfo } from '../diff/diffManager';
import { EditorStateManager } from './editorStateManager';
import { ParagraphModel } from '../models/paragraphModel';

/**
 * 差异处理服务 - 负责处理与DiffManager相关的操作
 */
export class DiffHandlerService {
    private diffManager: DiffManager | undefined;
    constructor(private editorStateManager: EditorStateManager) {}

    /**
     * 设置DiffManager实例
     */
    public setDiffManager(diffManager: DiffManager): void {
        this.diffManager = diffManager;
    }

    /**
     * 查找段落对应的变更信息
     */
    public findChangeInfoForParagraphModel(paragraph: ParagraphModel, editor: vscode.TextEditor): ChangeInfo | undefined {
        if (!this.diffManager) return undefined;

        const changes = this.editorStateManager.getChanges(editor);

        return changes.find(change =>
            change.range.isEqual(paragraph.range) &&
            change.original === paragraph.originalContent &&
            change.corrected === paragraph.correctedContent
        );
    }

    /**
     * 从DiffManager中清理段落相关状态
     */
    public cleanupParagraphFromDiffManager(paragraph: ParagraphModel, editor: vscode.TextEditor): void {
        if (!this.diffManager) {
            return;
        }

        try {
            console.log(`[CleanupDiff] 清理段落 ${paragraph.id} 的diff状态`);

            // 查找并移除相关的ChangeInfo
            const changeInfo = this.findChangeInfoForParagraphModel(paragraph, editor);
            if (changeInfo) {
                console.log(`[CleanupDiff] 找到对应的ChangeInfo，移除中...`);

                // 使用DiffManager的公开方法移除change
                const changes = this.editorStateManager.getChanges(editor);
                const index = changes.indexOf(changeInfo);
                if (index > -1) {
                    // 直接从changes数组中移除
                    this.editorStateManager.removeChange(editor, changeInfo);
                    console.log(`[CleanupDiff] 已从changes列表中移除ChangeInfo`);
                }
            } else {
                console.warn(`[CleanupDiff] 未找到段落 ${paragraph.id} 对应的ChangeInfo`);
                
                // 即使没有找到精确匹配的ChangeInfo，也尝试清理可能相关的变更
                // 查找与段落范围重叠的所有变更
                const changes = this.editorStateManager.getChanges(editor);
                const overlappingChanges = changes.filter(change => 
                    change.range.intersection(paragraph.range) !== undefined
                );
                
                if (overlappingChanges.length > 0) {
                    console.log(`[CleanupDiff] 找到 ${overlappingChanges.length} 个与段落范围重叠的变更，清理中...`);
                    for (const change of overlappingChanges) {
                        this.editorStateManager.removeChange(editor, change);
                    }
                }
            }

            // 强制清理所有装饰
            this.diffManager.clearDecorationsForEditor(editor);
            // 强制更新装饰
            this.diffManager.updateDecorationsForEditor(editor);
            console.log(`[CleanupDiff] 段落 ${paragraph.id} 的diff状态清理完成`);
        } catch (error) {
            console.warn('清理DiffManager状态时出错:', error);
        }
    }

}

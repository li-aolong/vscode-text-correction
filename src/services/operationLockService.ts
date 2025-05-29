import * as vscode from 'vscode';

/**
 * 操作锁服务 - 负责管理并发操作锁
 */
export class OperationLockService {
    // 操作锁：防止并发操作导致的状态混乱
    private operationLocks: Map<string, boolean> = new Map();

    /**
     * 获取操作锁的键
     */
    public getOperationLockKey(editor: vscode.TextEditor, operation: string, paragraphId?: string): string {
        const editorUri = editor.document.uri.toString();
        return paragraphId ? `${editorUri}:${operation}:${paragraphId}` : `${editorUri}:${operation}`;
    }

    /**
     * 尝试获取操作锁
     */
    public tryAcquireOperationLock(lockKey: string): boolean {
        if (this.operationLocks.get(lockKey)) {
            return false; // 锁已被占用
        }
        this.operationLocks.set(lockKey, true);
        return true;
    }

    /**
     * 释放操作锁
     */
    public releaseOperationLock(lockKey: string): void {
        this.operationLocks.delete(lockKey);
    }
}

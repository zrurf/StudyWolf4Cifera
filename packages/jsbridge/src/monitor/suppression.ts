/**
 * 上报替换的抑制窗口。
 *
 * 插件自己也会发监控协议（向客户端要一帧真实人脸）。这些回复必须原样送到 `requestFaceFrame`，
 * 不能被替换管线拦走，否则取脸会一直超时。窗口用计数实现，允许重入。
 *
 * 单独成模块是为了避免 `replace.ts` 与 `face/request.ts` 互相 import 形成环。
 */

let depth = 0;

/** 在回调执行期间让上报替换放行监控回复。 */
export async function withMonitorReplacementSuppressed<T>(run: () => Promise<T>): Promise<T> {
    depth++;
    try {
        return await run();
    } finally {
        depth--;
    }
}

/** 命令式开启抑制，返回结束函数；适合“订阅 → 等待 → 解绑”这类跨异步边界的场景。 */
export function beginMonitorReplacementSuppression(): () => void {
    depth++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        depth--;
    };
}

/** 当前是否处于抑制窗口内。 */
export function isMonitorReplacementSuppressed(): boolean {
    return depth > 0;
}

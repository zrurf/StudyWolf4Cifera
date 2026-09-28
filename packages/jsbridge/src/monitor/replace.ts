import { frameToJpegBlob } from '@study-wolf-cifera/fake-screen';

import { jsBridge } from '../bridge.js';
import { findFrameCandidate } from '../face/frame.js';
import { requestFaceFrame } from '../face/request.js';
import { resolveUploadPuid } from './client-info.js';
import { captureMonitorFrame } from './frame.js';
import { rewriteObjectIds } from './rewrite.js';
import { pageUploadContext, uploadMonitorFrame, type MonitorUploadContext, type MonitorUploadResult } from './upload.js';

/**
 * 上报伪造结果：拦下客户端的监控回复，把其中的 objectId 换成我们上传的伪造截屏。
 *
 * 为什么必须这么做（源码核实）：二进制始终由客户端上传，页面只上报元数据。所以只改 id 会让服务端
 * 指向一张不存在的图；正确做法是页面自己把伪造帧传到同一个云盘接口，再把客户端回复里的 id 换掉，页面
 * 后续的元数据上报（`/keeper/api/receiveExamLogs`）就会带着我们的 id 走。
 *
 * 拦截点在 `preTrigger`：命中监控协议且回复里确实带画面引用时，取消这次分发，异步完成
 * 「合成 → 上传 → 改写 → 重新分发」。任何一步失败都把**原包**原样放回去，监控流程不会因为插件缺条回复。
 */

/** 仅替换截屏回复；人脸取帧回复必须透传，避免合成时再次触发自身。 */
export const MONITOR_PROTOCOLS = [
    'CLIENT_SCREEN_MONITOR',
    'CLIENT_SNAPSHOT'
];

/** 合成器：产出整屏伪造帧。 */
export type FrameComposer = () => Promise<HTMLCanvasElement>;
/** 上传器：把伪造帧送上去，换回 objectId。 */
export type FrameUploader = (frame: Blob) => Promise<MonitorUploadResult>;

/** 一次替换的结果，供日志与测试使用。 */
export interface ReplacementEvent {
    protocol: string;
    /** 成功指"换成了自己的 id 并重新分发"。 */
    ok: boolean;
    objectId: string | null;
    /** 失败或跳过的原因。 */
    reason?: string;
    elapsedMs: number;
}

/** {@link installMonitorFrameReplacement} 的参数。 */
export interface MonitorReplacementOptions {
    /** 自定义合成器；默认走 fake-screen + 客户端真实人脸画面。 */
    compose?: FrameComposer;
    /** 自定义上传器；默认走云盘接口。 */
    upload?: FrameUploader;
    /** 合成与上传各自的超时，毫秒，默认 20 秒。 */
    timeoutMs?: number;
    /** 事件回调。 */
    onEvent?: (event: ReplacementEvent) => void;
}

/** 已重新分发过的载荷；用它避免替换后的 trigger 再次进入拦截器。 */
const REPLAYED = new WeakSet<object>();

/** 给 Promise 加超时，避免合成或上传卡住后监控回复永远不发。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what}超时`)), ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 默认合成器：向客户端要一帧真实画面，再拼出整屏。 */
async function defaultCompose(): Promise<HTMLCanvasElement> {
    const face = await requestFaceFrame({ timeoutMs: 15_000 });
    const frame = await captureMonitorFrame({
        withFace: false,
        compose: { face: { enabled: true, source: face.image } }
    });
    return frame.canvas;
}

/** 默认上传器：云盘接口，`puid` 先看页面再问客户端。 */
async function defaultUpload(frame: Blob, context: MonitorUploadContext): Promise<MonitorUploadResult> {
    const puid = await resolveUploadPuid();
    return uploadMonitorFrame(frame, {
        ...pageUploadContext(),
        ...context,
        puid: puid.value ?? undefined,
        puidSource: puid.source,
        puidTried: puid.tried
    });
}

/**
 * 安装监控上报替换。
 *
 * @param options - 合成/上传钩子、超时与事件回调。
 * @returns 卸载函数；卸载后监控回复恢复原样。
 */
export function installMonitorFrameReplacement(
    options: MonitorReplacementOptions = {}
): () => void {
    const compose = options.compose ?? defaultCompose;
    const timeoutMs = options.timeoutMs ?? 20_000;
    // 按协议保存页面发给客户端的上传上下文，不依赖已删除的探针流量记录。
    const uploadContexts = new Map<string, MonitorUploadContext>();
    const stopContext = jsBridge.use('prePostNotification', (ctx, next) => {
        const args = ctx.args as { name?: string; payload?: {
            uploadParams?: Record<string, unknown>;
            uploadConfig?: { uploadUrl?: string };
        } };
        if (args.name && MONITOR_PROTOCOLS.includes(args.name) && args.payload) {
            const params: Record<string, string> = {};
            for (const [key, value] of Object.entries(args.payload.uploadParams ?? {})) {
                if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
            }
            const context: MonitorUploadContext = { params };
            if (args.payload.uploadConfig?.uploadUrl) context.uploadUrl = args.payload.uploadConfig.uploadUrl;
            uploadContexts.set(args.name, context);
        }
        next();
    }, { name: 'sw4c-monitor-upload-context' });

    const replace = async (protocol: string, payload: Record<string, unknown>): Promise<void> => {
        const context = uploadContexts.get(protocol) ?? {};
        const upload = options.upload ?? ((frame: Blob) => defaultUpload(frame, context));
        const startedAt = Date.now();
        const finish = (event: Omit<ReplacementEvent, 'protocol' | 'elapsedMs'>): void => {
            options.onEvent?.({ protocol, elapsedMs: Date.now() - startedAt, ...event });
        };

        try {
            const canvas = await withTimeout(compose(), timeoutMs, '合成');
            const blob = await withTimeout(frameToJpegBlob(canvas, 0.9), timeoutMs, '编码');
            const result = await withTimeout(upload(blob), timeoutMs, '上传');
            if (!result.ok || !result.objectId) {
                throw new Error(result.body || `上传未返回 objectId（HTTP ${result.status}）`);
            }

            const replaced = rewriteObjectIds(payload, result.objectId);
            REPLAYED.add(payload);
            jsBridge.trigger(protocol, payload);
            finish({
                ok: replaced > 0,
                objectId: result.objectId,
                reason: replaced > 0 ? undefined : '回复里没有可替换的 objectId'
            });
        } catch (error) {
            // 失败也要把原包发回去：宁可画面是真的，也不能让监控流程少一条回复。
            REPLAYED.add(payload);
            jsBridge.trigger(protocol, payload);
            finish({
                ok: false,
                objectId: null,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
    };

    const stopReplacement = jsBridge.use(
        'preTrigger',
        (ctx, next) => {
            const args = ctx.args as { name?: string; userInfo?: unknown };
            if (!args?.name || !MONITOR_PROTOCOLS.includes(args.name)) {
                next();
                return;
            }

            const payload = args.userInfo;
            if (!payload || typeof payload !== 'object' || REPLAYED.has(payload)) {
                next();
                return;
            }

            // 只有带回画面引用的回复才值得替换；纯状态回包直接放过。
            if (!findFrameCandidate(payload)) {
                next();
                return;
            }

            ctx.cancel = true;
            void replace(args.name, payload as Record<string, unknown>);
        },
        { name: 'sw4c-monitor-replacement', priority: 100 }
    );
    return () => {
        stopReplacement();
        stopContext();
        uploadContexts.clear();
    };
}

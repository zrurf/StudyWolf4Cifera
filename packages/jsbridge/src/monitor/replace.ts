import { frameToJpegBlob } from '@study-wolf-cifera/fake-screen';

import { jsBridge } from '../bridge.js';
import { DEFAULT_OBJECT_ID_URL, findFrameCandidate, loadReadableImage } from '../face/frame.js';
import { requestFaceFrame } from '../face/request.js';
import { rewriteUrl } from '../utils/proxy_url.js';
import { resolveUploadPuid } from './client-info.js';
import { captureMonitorFrame } from './frame.js';
import {
    dropSignatureFields,
    hasInlineImageFiles,
    rewriteInlineImages,
    rewriteObjectIds
} from './rewrite.js';
import { isMonitorReplacementSuppressed } from './suppression.js';
import {
    harvestUploadContext,
    pageUploadContext,
    uploadMonitorFrame,
    type HarvestedUpload,
    type MonitorUploadResult
} from './upload.js';

/**
 * 上报伪造结果：拦下客户端的监控回复，把其中的画面换成我们合成、自己上传的那一份。
 *
 * 为什么必须这么做（源码核实）：二进制始终由客户端上传，页面只上报元数据。只改 id 会让服务端指向一张不
 * 存在的图；正确做法是页面自己把伪造帧传到同一个云盘接口，再把回复里的 id 换掉，页面后续的元数据上报
 * （`/keeper/api/receiveExamLogs`）就会带着我们的 id 走。
 *
 * 入口在 `preTrigger`：命中监控协议且回复里确实带画面（objectId 或内联 base64）时，取消这次分发，串行完成
 * 「合成 → 上传 → 改写 → 重新分发」。任何一步失败都把**原包**原样放回去，监控流程不会因为插件缺条回复。
 *
 * 这个模块是**常驻**的：`index.ts` 在页面加载时就装上（可用 `localStorage['sw4c-monitor-hijack']='0'`
 * 关掉），探针只负责订阅事件与临时开关。
 */

/** 会被改写的协议：客户端在这些回复里带回画面。 */
export const MONITOR_PROTOCOLS = [
    'CLIENT_SCREEN_MONITOR',
    'CLIENT_SNAPSHOT',
    'CLIENT_FACE_COLLECTION',
    'CLIENT_FACE_RECOGNITION_BLINK'
];

/** 人脸类协议：它们的回复里带的是真实摄像头画面，可以直接当悬浮窗内容。 */
const FACE_PROTOCOLS = new Set(['CLIENT_FACE_COLLECTION', 'CLIENT_FACE_RECOGNITION_BLINK']);

/** 合成器：拿到真实人脸画面（可能为空）后产出整屏伪造帧。 */
export type FrameComposer = (face: HTMLImageElement | null) => Promise<HTMLCanvasElement>;
/** 上传器：把伪造帧送上去，换回 objectId；第二个参数是触发的协议名。 */
export type FrameUploader = (frame: Blob, protocol: string) => Promise<MonitorUploadResult>;

/** 一次替换的结果，供面板与日志展示。 */
export interface ReplacementEvent {
    protocol: string;
    /** 成功指"换成了自己的画面并重新分发"。 */
    ok: boolean;
    objectId: string | null;
    /** 失败或跳过的原因。 */
    reason?: string;
    /** 成功时的补充说明，例如签名被移除。 */
    note?: string;
    elapsedMs: number;
}

/** 安装参数。 */
export interface MonitorReplacementOptions {
    /** 自定义合成器；默认走 fake-screen + 客户端真实人脸画面（带缓存）。 */
    compose?: FrameComposer;
    /** 自定义上传器；默认走云盘接口。 */
    upload?: FrameUploader;
    /** 合成与上传各自的超时，毫秒，默认 20 秒。 */
    timeoutMs?: number;
    /**
     * 改写后是否移除 `signToken`。
     *
     * 客户端的 signToken 是对它自己的 objectId 签的，换了 id 之后原签名必然失配；留着会让服务端判定
     * “签名错误”，删掉则等同旧版客户端的不带签名上报。默认 true。
     */
    dropSignature?: boolean;
    /** 由 objectId 构造图片地址；默认用云盘模板，换域名/换代理时覆盖。 */
    objectIdUrl?: (objectId: string) => string;
    /** 事件回调。 */
    onEvent?: (event: ReplacementEvent) => void;
}

/** 常驻状态。 */
interface ReplacementRuntime {
    compose: FrameComposer;
    upload: FrameUploader;
    timeoutMs: number;
    dropSignature: boolean;
    objectIdUrl: (objectId: string) => string;
}

/** 已重新分发过的载荷，避免替换后的 trigger 再次进入拦截器。 */
const REPLAYED = new WeakSet<object>();

let runtime: ReplacementRuntime | null = null;
let removeRequestTap: (() => void) | null = null;
let removeReplyTap: (() => void) | null = null;
/**
 * 页面最近一次监控请求带来的上传上下文，**按协议分开记**。
 *
 * 截屏、抓拍、人脸三条链路的 `uploadConfig.uploadUrl` 可能不同（后端按业务注入），共用一个"最后一条"
 * 会把上一场次/另一业务的地址串过来。
 */
const harvestedByProtocol = new Map<string, HarvestedUpload>();
/** 串行队列：避免多次抓拍同时合成/上传把 CPU 打满。 */
let queue: Promise<void> = Promise.resolve();
/** 排队中的任务数；积压太多就直接放行原包。 */
let pending = 0;
const MAX_PENDING = 3;
const subscribers = new Set<(event: ReplacementEvent) => void>();

/** 真实人脸画面的缓存时长：客户端自己的抓拍间隔通常就在这个量级，过期后重新要一帧。 */
const FACE_REFRESH_MS = 5 * 60_000;
let cachedFace: HTMLImageElement | null = null;
let cachedFaceAt = 0;

function emit(event: ReplacementEvent): void {
    for (const listener of subscribers) {
        try {
            listener(event);
        } catch {
            // 订阅方出错不影响替换流程。
        }
    }
}

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
        // 成功路径也要清掉定时器，否则它会一直挂在事件循环里。
        clearTimeout(timer);
    }
}

/** 把 Blob 读成不带前缀的 base64。 */
function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error ?? new Error('读取 JPEG 失败'));
        reader.readAsDataURL(blob);
    });
}

/** 从人脸协议的原始回复里取真实画面，同时刷新缓存。 */
async function faceFromPayload(payload: unknown): Promise<HTMLImageElement | null> {
    const candidate = findFrameCandidate(payload);
    if (!candidate || candidate.kind !== 'objectId') return null;
    try {
        const toUrl = runtime?.objectIdUrl ?? DEFAULT_OBJECT_ID_URL;
        // 经代理改写后再加载：跨域直连会污染画布，toBlob 会抛 SecurityError。
        const image = await loadReadableImage(toUrl(candidate.value), rewriteUrl);
        cachedFace = image;
        cachedFaceAt = Date.now();
        return image;
    } catch {
        return null;
    }
}

/** 取悬浮窗要用的真实画面：优先缓存，过期后再向客户端要一帧。 */
async function currentFace(): Promise<HTMLImageElement | null> {
    if (cachedFace && Date.now() - cachedFaceAt < FACE_REFRESH_MS) return cachedFace;
    const result = await requestFaceFrame({ timeoutMs: 15_000 });
    if (result.image) {
        cachedFace = result.image;
        cachedFaceAt = Date.now();
    }
    return cachedFace;
}

/** 默认合成器。 */
async function defaultCompose(face: HTMLImageElement | null): Promise<HTMLCanvasElement> {
    const source = face ?? (await currentFace().catch(() => null));
    const frame = await captureMonitorFrame({
        withFace: false,
        compose: { face: { enabled: true, source } }
    });
    return frame.canvas;
}

/** 默认上传器：页面给的地址优先，`puid` 先看页面再问客户端。 */
async function defaultUpload(frame: Blob, protocol: string): Promise<MonitorUploadResult> {
    const puid = await resolveUploadPuid();
    const pageContext = pageUploadContext();
    const harvested = harvestedByProtocol.get(protocol) ?? null;
    return uploadMonitorFrame(frame, {
        ...pageContext,
        uploadUrl: harvested?.uploadUrl ?? pageContext.uploadUrl,
        isYunPan: harvested?.isYunPan,
        fid: harvested?.fid,
        isMirror: harvested?.isMirror,
        params: { ...(harvested?.params ?? {}), ...(pageContext.params ?? {}) },
        puid: puid.value ?? undefined,
        puidSource: puid.source,
        puidTried: puid.tried
    });
}

/** 一次完整的替换流程。 */
async function replaceOnce(protocol: string, payload: Record<string, unknown>): Promise<void> {
    const rt = runtime;
    if (!rt) return;
    const startedAt = Date.now();
    const replay = (): void => {
        REPLAYED.add(payload);
        jsBridge.trigger(protocol, payload);
    };

    try {
        // 人脸回复里带的就是真实摄像头画面，直接拿来当悬浮窗内容，省一次额外的抓拍。
        const face = FACE_PROTOCOLS.has(protocol) ? await faceFromPayload(payload) : null;
        const canvas = await withTimeout(rt.compose(face), rt.timeoutMs, '合成');
        const blob = await withTimeout(frameToJpegBlob(canvas, 0.9), rt.timeoutMs, '编码');
        const result = await withTimeout(rt.upload(blob, protocol), rt.timeoutMs, '上传');
        if (!result.ok || !result.objectId) {
            throw new Error(result.body || `上传未返回 objectId（HTTP ${result.status}）`);
        }

        let replaced = rewriteObjectIds(payload, result.objectId);
        if (hasInlineImageFiles(payload)) {
            const base64 = await withTimeout(blobToBase64(blob), rt.timeoutMs, '编码 base64');
            replaced += rewriteInlineImages(payload, base64);
        }
        const dropped = rt.dropSignature ? dropSignatureFields(payload) : 0;

        replay();
        emit({
            protocol,
            ok: replaced > 0,
            objectId: result.objectId,
            reason: replaced > 0 ? undefined : '回复里没有可替换的画面',
            note:
                replaced > 0 && dropped > 0
                    ? `已移除 ${dropped} 个 signToken（objectId 变了，原签名必然失配）`
                    : undefined,
            elapsedMs: Date.now() - startedAt
        });
    } catch (error) {
        // 失败也要把原包发回去：宁可画面是真的，也不能让监控流程少一条回复。
        replay();
        emit({
            protocol,
            ok: false,
            objectId: null,
            reason: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - startedAt
        });
    }
}

/**
 * 安装（或更新）上报替换。重复调用不会重复注册拦截器，只会更新钩子与订阅。
 *
 * @returns 卸载函数；调用后监控回复恢复原样。
 */
export function installMonitorFrameReplacement(options: MonitorReplacementOptions = {}): () => void {
    if (options.onEvent) subscribers.add(options.onEvent);

    if (runtime) {
        if (options.compose) runtime.compose = options.compose;
        if (options.upload) runtime.upload = options.upload;
        if (options.timeoutMs) runtime.timeoutMs = options.timeoutMs;
        if (options.dropSignature !== undefined) runtime.dropSignature = options.dropSignature;
        if (options.objectIdUrl) runtime.objectIdUrl = options.objectIdUrl;
        return () => {
            if (options.onEvent) subscribers.delete(options.onEvent);
        };
    }

    runtime = {
        compose: options.compose ?? defaultCompose,
        upload: options.upload ?? defaultUpload,
        timeoutMs: options.timeoutMs ?? 20_000,
        dropSignature: options.dropSignature !== false,
        objectIdUrl: options.objectIdUrl ?? DEFAULT_OBJECT_ID_URL
    };
    harvestedByProtocol.clear();

    removeRequestTap = jsBridge.use(
        'prePostNotification',
        (ctx, next) => {
            const args = ctx.args as { name?: string; payload?: unknown };
            if (args?.name && MONITOR_PROTOCOLS.includes(args.name)) {
                const fetched = harvestUploadContext([args.payload]);
                // 只有真的带来上传信息时才记住，避免把上一场次的地址留在手里。
                if (Object.keys(fetched.params).length > 0 || fetched.uploadUrl) {
                    harvestedByProtocol.set(args.name, fetched);
                }
            }
            next();
        },
        { name: 'sw4c-monitor-upload-context', priority: 100 }
    );

    removeReplyTap = jsBridge.use(
        'preTrigger',
        (ctx, next) => {
            const args = ctx.args as { name?: string; userInfo?: unknown };
            if (!args?.name || !MONITOR_PROTOCOLS.includes(args.name)) {
                next();
                return;
            }

            // 插件自己在等这帧画面（requestFaceFrame）时放行，避免把自己的请求吞掉。
            if (isMonitorReplacementSuppressed()) {
                next();
                return;
            }

            const payload = args.userInfo;
            if (!payload || typeof payload !== 'object' || REPLAYED.has(payload)) {
                next();
                return;
            }

            // 只有带回画面的回复才值得替换（objectId 或内联 base64）；纯状态回包直接放过。
            if (!findFrameCandidate(payload) && !hasInlineImageFiles(payload)) {
                next();
                return;
            }

            // 积压太多时本条不排队，直接放行原包，避免监控回复越拖越久。
            if (pending >= MAX_PENDING) {
                emit({
                    protocol: args.name,
                    ok: false,
                    objectId: null,
                    reason: `队列积压（${pending}），本条按原样放行`,
                    elapsedMs: 0
                });
                next();
                return;
            }

            ctx.cancel = true;
            pending++;
            queue = queue
                .then(() => replaceOnce(args.name!, payload as Record<string, unknown>))
                .catch(() => undefined)
                .finally(() => {
                    pending--;
                });
        },
        { name: 'sw4c-monitor-replacement', priority: 100 }
    );

    return uninstallMonitorFrameReplacement;
}

/** 卸下拦截器；已订阅的事件回调保留，重新安装后继续生效。 */
export function uninstallMonitorFrameReplacement(): void {
    removeRequestTap?.();
    removeReplyTap?.();
    removeRequestTap = null;
    removeReplyTap = null;
    runtime = null;
    pending = 0;
}

/** 当前是否已安装。 */
export function isMonitorReplacementInstalled(): boolean {
    return runtime !== null;
}

/**
 * 订阅替换事件（成功、失败、跳过都会推送）。
 *
 * @returns 取消订阅的函数。
 */
export function subscribeMonitorReplacement(listener: (event: ReplacementEvent) => void): () => void {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
}

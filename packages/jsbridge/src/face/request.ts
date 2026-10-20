import type { Callback } from '@study-wolf-cifera/shared-types';

import { jsBridge } from '../bridge.js';
import { withMonitorReplacementSuppressed } from '../monitor/suppression.js';
import { rewriteUrl } from '../utils/proxy_url.js';
import { DEFAULT_OBJECT_ID_URL, findFrameCandidate, loadReadableImage } from './frame.js';

/**
 * 向客户端索取一帧实时摄像头画面。
 *
 * 监考时客户端显示的前置摄像头画面是系统级悬浮窗，像素不会进入页面 DOM，也就无法随页面
 * 一起截取。要拿到真实画面只能向客户端要：`CLIENT_FACE_COLLECTION` 会启动采集流程，客户端
 * 随后以已上传画面的 cloud objectId（取决于版本，也可能是图片本身）作答。
 */

/** {@link requestFaceFrame} 的参数。 */
export interface FaceFrameRequest {
    /** 等待可用画面的上限，毫秒；默认 30000。 */
    timeoutMs?: number;
    /** 请求客户端的采集间隔，毫秒；默认 1000。客户端以此周期采集，首帧在该周期之后到达。 */
    internalTimeMs?: number;
    /** 拿到首帧后是否让客户端继续采集；默认 false。 */
    keepCapturing?: boolean;
    /** 由 objectId 构造图片地址。 */
    objectIdUrl?: (objectId: string) => string;
    /** 把地址改写成页面可读的形式；默认走 Cifera 代理改写。 */
    rewrite?: (url: string) => string;
}

/** 一次人脸取帧的结果。 */
export interface FaceFrameResult {
    /** 已载入的摄像头画面；超时或客户端不回图时为 `null`。 */
    image: HTMLImageElement | null;
    /** 画面来源的 cloud objectId，若存在。 */
    objectId: string | null;
    /** 客户端的第一条可用回复，保留用于诊断与协议调研。 */
    reply: unknown;
    /** 画面获得方式。 */
    source: 'url' | 'objectId' | 'none';
}

/** 客户端可能用来回复采集结果的协议。 */
const REPLY_PROTOCOLS = ['CLIENT_FACE_COLLECTION', 'CLIENT_FACE_RECOGNITION_BLINK'];

/**
 * 启动客户端人脸采集，并在收到首帧后返回。
 *
 * 除非 `keepCapturing` 为真，返回前会请求客户端停止采集，避免把摄像头一直留着。超时未收到
 * 画面时返回 `image: null`，由调用方决定是否退化为占位图。
 */
export async function requestFaceFrame(request: FaceFrameRequest = {}): Promise<FaceFrameResult> {
    // 客户端对 CLIENT_FACE_COLLECTION 的回复不能被上报替换拦走，否则这里会一直等到超时。
    return withMonitorReplacementSuppressed(() => requestFaceFrameInner(request));
}

/** {@link requestFaceFrame} 的主体，外层只负责开抑制窗口。 */
async function requestFaceFrameInner(request: FaceFrameRequest = {}): Promise<FaceFrameResult> {
    const {
        timeoutMs = 30_000,
        internalTimeMs = 1000,
        keepCapturing = false,
        objectIdUrl = DEFAULT_OBJECT_ID_URL,
        rewrite = rewriteUrl
    } = request;

    let resolveFirst: ((reply: unknown) => void) | null = null;
    const firstReply = new Promise<unknown>((resolve) => {
        resolveFirst = resolve;
    });

    const listeners = new Map<string, Callback>();
    for (const protocol of REPLY_PROTOCOLS) {
        const listener: Callback = (payload) => {
            if (findFrameCandidate(payload)) resolveFirst?.(payload);
        };
        listeners.set(protocol, listener);
        jsBridge.bind(protocol, listener);
    }

    const stopCapturing = (): void => {
        jsBridge.postNotification('CLIENT_FACE_COLLECTION', {
            enable: '0',
            enableCapture: '0',
            data: { internalTime: '60000', funconfig: {} }
        });
    };

    try {
        jsBridge.postNotification('CLIENT_FACE_COLLECTION', {
            enable: '1',
            enableCapture: '1',
            data: { internalTime: String(internalTimeMs), funconfig: {} }
        });

        const reply = await Promise.race([
            firstReply,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);

        if (!reply) return { image: null, objectId: null, reply: null, source: 'none' };

        const candidate = findFrameCandidate(reply);
        if (!candidate) return { image: null, objectId: null, reply, source: 'none' };

        const url = candidate.kind === 'objectId' ? objectIdUrl(candidate.value) : candidate.value;
        const objectId = candidate.kind === 'objectId' ? candidate.value : null;
        try {
            const image = await loadReadableImage(url, rewrite);
            return { image, objectId, reply, source: objectId ? 'objectId' : 'url' };
        } catch {
            // 客户端给了 id 但取不回图（地址模板变了、图被清理、代理不可达……）：如实返回
            // "没有画面"，调用方退化为剪影即可，不该整条合成链路一起失败。
            return { image: null, objectId, reply, source: 'none' };
        }
    } finally {
        for (const [protocol, listener] of listeners) jsBridge.unbind(protocol, listener);
        if (!keepCapturing) {
            try {
                stopCapturing();
            } catch {
                // 客户端可能已经退出，停止采集尽力而为。
            }
        }
    }
}

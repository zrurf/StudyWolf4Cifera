import type {
    Callback,
    IJSBridge,
    InterceptorContext,
    InterceptorHandler,
    InterceptorOptions,
    InterceptorPoint
} from '@study-wolf-cifera/shared-types';

import { jsBridge } from './bridge.js';
import { clearBridgeLog, dumpBridgeLog, startBridgeRecorder } from './debug/recorder.js';
import { findFrameCandidate, loadReadableImage } from './face/frame.js';
import { requestFaceFrame } from './face/request.js';
import { interceptorKeyboard, interceptorSwitch, interceptorTitle } from './interceptors/derestrict.js';
import { interceptorProxyAdapter } from './interceptors/proxy_adapter.js';
import { captureMonitorFrame } from './monitor/frame.js';
import { installMonitorFrameReplacement } from './monitor/replace.js';
import { jsBridgeEnv, leftButtonIconUrl } from './utils/env.js';
import { rewriteUrl } from './utils/proxy_url.js';

export type { IJSBridge, Callback, InterceptorContext, InterceptorHandler, InterceptorOptions, InterceptorPoint };
export { InterceptorManager } from './interceptor.js';
export { jsBridge, jsBridgeEnv, leftButtonIconUrl, rewriteUrl };
export { captureMonitorFrame, type MonitorFrameRequest } from './monitor/frame.js';
export {
    DEFAULT_PAN_UPLOAD_URL,
    pageUploadContext,
    resolvePuid,
    uploadMonitorFrame,
    type MonitorUploadContext,
    type MonitorUploadResult,
    type PuidResolution
} from './monitor/upload.js';
export { requestClientUserInfo, resolveUploadPuid } from './monitor/client-info.js';
export {
    MONITOR_PROTOCOLS,
    installMonitorFrameReplacement,
    type MonitorReplacementOptions,
    type ReplacementEvent
} from './monitor/replace.js';
export { findPuidInReply, rewriteObjectIds } from './monitor/rewrite.js';
export { findFrameCandidate, loadReadableImage, DEFAULT_OBJECT_ID_URL, type FrameCandidate } from './face/frame.js';
export {
    requestFaceFrame,
    type FaceFrameRequest,
    type FaceFrameResult
} from './face/request.js';
export {
    clearBridgeLog,
    dumpBridgeLog,
    startBridgeRecorder,
    type BridgeLogEntry
} from './debug/recorder.js';

// 提前建好环境对象，后续拦截器回调不必再判空。
jsBridgeEnv();

// 页面发给客户端的请求。
jsBridge.use('prePostNotification', interceptorProxyAdapter);
jsBridge.use('prePostNotification', interceptorKeyboard);
jsBridge.use('prePostNotification', interceptorTitle);

// 客户端发给页面的回复。
jsBridge.use('preTrigger', interceptorSwitch);

// 默认安装截屏上报替换；不创建探针面板，不自动发起协议探测。
export const stopMonitorFrameReplacement = installMonitorFrameReplacement();

/**
 * 控制台 API。
 *
 * bundle 是 IIFE，导出的绑定在页面里拿不到；这个命名空间是协议调研时驱动构图与录制器的
 * 入口（WebView 检查器或 CDP 会话）。
 */
(window as Window & { __STUDY_WOLF__?: unknown }).__STUDY_WOLF__ = {
    jsBridge,
    jsBridgeEnv,
    leftButtonIconUrl,
    rewriteUrl,
    requestFaceFrame,
    captureMonitorFrame,
    findFrameCandidate,
    loadReadableImage,
    startBridgeRecorder,
    dumpBridgeLog,
    clearBridgeLog,
    stopMonitorFrameReplacement
};

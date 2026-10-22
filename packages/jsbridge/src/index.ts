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
import {
    installMonitorFrameReplacement,
    isMonitorReplacementInstalled,
    subscribeMonitorReplacement,
    uninstallMonitorFrameReplacement
} from './monitor/replace.js';
import { faceProbeEnabled, installFaceProbe } from './probe/face-probe.js';
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
    isMonitorReplacementInstalled,
    subscribeMonitorReplacement,
    uninstallMonitorFrameReplacement,
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
export { faceProbeEnabled, installFaceProbe, type FaceProbeApi, type FaceProbeReport } from './probe/face-probe.js';

// 提前建好环境对象，后续拦截器回调不必再判空。
jsBridgeEnv();

// 页面发给客户端的请求。
jsBridge.use('prePostNotification', interceptorProxyAdapter);
jsBridge.use('prePostNotification', interceptorKeyboard);
jsBridge.use('prePostNotification', interceptorTitle);

// 客户端发给页面的回复。
jsBridge.use('preTrigger', interceptorSwitch);

/**
 * 上报伪造：默认常驻。
 *
 * 每一次监控回复都会被换成我们合成、自己上传的截屏。需要临时关掉时在控制台里设
 * `localStorage['sw4c-monitor-hijack'] = '0'` 并刷新，或用 `__STUDY_WOLF__.uninstallMonitorFrameReplacement()`。
 */
const monitorHijackDisabled = (() => {
    try {
        return localStorage.getItem('sw4c-monitor-hijack') === '0';
    } catch {
        return false;
    }
})();
if (!monitorHijackDisabled) installMonitorFrameReplacement();

/**
 * 人脸悬浮窗探针：**默认完全关闭**。
 *
 * 关着的状态下不建面板、不记录流量、不写 localStorage，页面里也不会出现 `__SW4C_FACE_PROBE__`。
 * 需要时三选一：
 * 1. `localStorage['sw4c-face-probe'] = '1'`（或 URL 带 `sw4c_face_probe`）后刷新；
 * 2. 注入 `dist/jsbridge-probe.js`（bridge + 探针，注入即运行）；
 * 3. 控制台里 `__STUDY_WOLF__.installFaceProbe({ panel: true })`。
 */
const faceProbe = faceProbeEnabled() ? installFaceProbe({ autoRun: true, panel: true }) : null;

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
    faceProbe,
    installFaceProbe,
    installMonitorFrameReplacement,
    uninstallMonitorFrameReplacement,
    isMonitorReplacementInstalled,
    subscribeMonitorReplacement
};

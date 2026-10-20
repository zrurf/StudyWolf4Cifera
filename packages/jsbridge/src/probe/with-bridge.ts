import '../index.js';
import { captureMonitorFrame } from '../monitor/frame.js';
import {
    installMonitorFrameReplacement,
    isMonitorReplacementInstalled,
    subscribeMonitorReplacement,
    uninstallMonitorFrameReplacement
} from '../monitor/replace.js';
import { installFaceProbe } from './face-probe.js';

/**
 * 「注入即生效」入口（构建为 `dist/jsbridge-probe.js`）。
 *
 * 与 `jsbridge.js` 的唯一区别是探针无条件自动运行，因此不需要检查器、不需要开关：把
 * `addon.toml` 里顶替 `CXJSBridge.js` 的规则指向本文件，页面一加载就会依次试各种人脸协议，结果
 * 显示在右上角面板里。普通使用请继续用 `jsbridge.js`。
 *
 * 另外两处接线：面板上的「合成伪造帧」用这里的构图实现；「上报劫持」开关用这里的替换管线。两者都由
 * 宿主注入给探针，这样独立探针产物（`face-probe.js`）不会被拖进 bridge 与 SnapDOM。
 */

/** 最近一次取到的人脸画面，供劫持时合成复用。 */
let lastFace: HTMLImageElement | null = null;

const composeFrame = async (face: HTMLImageElement | null): Promise<HTMLCanvasElement> => {
    lastFace = face ?? lastFace;
    return (
        await captureMonitorFrame({
            withFace: false,
            compose: { face: { enabled: true, source: lastFace } }
        })
    ).canvas;
};

// 探针的「上报自测」也要能合成整屏，把同一份实现借给它用，避免重复打包一份构图模块。
(window as unknown as { __SW4C_FACE_PROBE_COMPOSE__?: typeof composeFrame }).__SW4C_FACE_PROBE_COMPOSE__ =
    composeFrame;

// 上报劫持的订阅句柄：探针开关只负责订阅/退订与启停，管线本身由 index.ts 常驻安装。
let offReplacement: (() => void) | null = null;

installFaceProbe({
    autoRun: true,
    // 复用探针已经拿到的那张画面，不再重复向客户端要图。
    compose: composeFrame,
    startReplace: (onEvent) => {
        offReplacement?.();
        offReplacement = subscribeMonitorReplacement(onEvent);
        installMonitorFrameReplacement();
    },
    stopReplace: () => {
        offReplacement?.();
        offReplacement = null;
        uninstallMonitorFrameReplacement();
    },
    replaceActive: () => isMonitorReplacementInstalled()
});

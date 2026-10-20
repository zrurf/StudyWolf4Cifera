import { DEFAULT_OBJECT_ID_URL, findFrameCandidate, loadReadableImage } from '../face/frame.js';
// 只取类型与纯函数：探针必须能独立注入，不能把 bridge、构图模块或 SnapDOM 一起拖进产物。
import type { ReplacementEvent } from '../monitor/replace.js';
import { findPuidInReply } from '../monitor/rewrite.js';
import { beginMonitorReplacementSuppression } from '../monitor/suppression.js';
import {
    harvestUploadContext,
    pageUploadContext,
    resolvePuid,
    uploadMonitorFrame,
    type MonitorUploadResult
} from '../monitor/upload.js';

/**
 * 人脸悬浮窗唤起探针。
 *
 * 用途：在真机（学习通客户端 WebView，经 Cifera 注入）上确认客户端到底能不能被唤起人脸
 * 悬浮窗/人脸采集。探针在页面打开后按顺序尝试几种候选协议，记录每一次请求与客户端的每一条
 * 回复，并把结果展示在页面右上角的面板里、同时写入 localStorage，便于回传分析。
 *
 * 约束：
 * - 不接管 `window.jsBridge`，只操作页面已有的 bridge，因此可以单独注入使用（`dist/face-probe.js`）。
 * - 只发协议、只监听回复，不改页面状态；唯一的例外是录屏步骤，可用配置关闭。
 */

/** 探针配置。 */
export interface FaceProbeOptions {
    /** 是否在页面加载后自动运行；默认由 {@link faceProbeEnabled} 决定。 */
    autoRun?: boolean;
    /** 是否包含录屏抓拍步骤（会把整屏画面上传到超星）。默认 true。 */
    includeScreenMonitor?: boolean;
    /** 每步等待时间的倍率，用于快速自检；默认 1。 */
    waitScale?: number;
    /** 是否显示页面面板；默认 true。 */
    panel?: boolean;
    /**
     * 有副作用的步骤在非考试页发送前弹确认（防被客户端关页），默认 true。
     */
    confirmRisky?: boolean;
    /** 由 objectId 构造图片地址；默认用 {@link DEFAULT_OBJECT_ID_URL}。 */
    objectIdUrl?: (objectId: string) => string;
    /**
     * 合成伪造帧的可选钩子：传入最近一次取到的摄像头画面，返回已合成的画布。提供后面板上会多出
     * 「合成伪造帧」按钮，用于在真机上肉眼比对伪造帧与真实截屏。
     */
    compose?: (face: HTMLImageElement | null) => Promise<HTMLCanvasElement>;
    /**
     * 上报劫持的三个可选钩子：宿主传入后，面板上会多出开关。探针自身不实现替换（那会把 bridge 与构图
     * 模块一起打进独立探针产物），只负责订阅事件与启停常驻管线。
     */
    startReplace?: (onEvent: (event: ReplacementEvent) => void) => void;
    stopReplace?: () => void;
    replaceActive?: () => boolean;
}

/** 一个候选步骤。 */
interface ProbeStep {
    id: string;
    label: string;
    protocol: string;
    payload: unknown;
    waitMs: number;
    /** 这一步在验证什么。 */
    note: string;
    /** 有副作用、可能干扰当前页时写明原因；发送前会按需二次确认。 */
    risky?: string;
}

/** 客户端的一条回复。 */
interface ProbeReply {
    protocol: string;
    /** `object` 或 `string`：不同协议回复的载荷类型不一致，需要记录。 */
    type: string;
    payload: unknown;
    elapsedMs: number;
}

/** 步骤执行结果。 */
interface StepResult {
    id: string;
    label: string;
    protocol: string;
    note: string;
    payload: unknown;
    waitMs: number;
    replies: ProbeReply[];
    /** 找到画面时的证据：来源、可加载的地址、尺寸。 */
    image?: { source: string; value: string; loadUrl: string; width: number; height: number };
    error?: string;
    /** 因风险被跳过时的原因（用户取消或判定不安全）。 */
    skipped?: string;
}

/** 一条 bridge 流量。 */
interface TrafficEntry {
    elapsedMs: number;
    direction: 'toClient' | 'toPage' | 'bind' | 'unbind';
    protocol: string;
    args: unknown[];
}

/** 探针报告，也是回传分析的内容。 */
export interface FaceProbeReport {
    startedAt: string;
    finishedAt?: string;
    environment: {
        pageUrl: string;
        userAgent: string;
        /** 屏幕、视口与像素比：`screenHeightCss - viewportHeightCss` 即客户端外壳高度。 */
        metrics: {
            screenWidthCss: number;
            screenHeightCss: number;
            viewportWidthCss: number;
            viewportHeightCss: number;
            dpr: number;
            /** 外壳（状态栏 + 工具栏 + 导航栏）高度，CSS px；算不出时为 null。 */
            chromeHeightCss: number | null;
        };
        /** 从 UA 解析的客户端版本串，形如 `3_6.7.2_android_phone_10936_311`。 */
        appVersion: string | null;
        /** 当前 bridge 是本项目注入的还是客户端原生的。 */
        bridge: 'study-wolf' | 'client' | 'unknown';
        hasWebBridge: boolean;
        hasAndroidBridge: boolean;
        androidBridgeKeys: string[];
        device: string | null;
        isReady: boolean | null;
        hasCiferaConfig: boolean;
        /** 探针启动前页面自身已经发过的协议。 */
        pageTrafficBeforeProbe: TrafficEntry[];
    };
    steps: StepResult[];
    traffic: TrafficEntry[];
    notes: string[];
    /** 「合成伪造帧」的结果，只在该按钮被按下后出现。 */
    compose?: { ok: boolean; width: number; height: number; bytes: number; error?: string };
    /** 已发生的上报替换事件（开启劫持后才有）。 */
    replacements?: ReplacementEvent[];
    /** 「上报自测」的结果，只在该按钮被按下后出现。 */
    upload?: {
        ok: boolean;
        objectId: string | null;
        status: number;
        body: string;
        url: string;
        /** 取回上传结果是否成功（成功即说明服务端确实收下了这张图）。 */
        fetchedBack: boolean;
    };
}

/** 探针对外暴露的 API（挂在 `window.__SW4C_FACE_PROBE__`）。 */
export interface FaceProbeApi {
    run: (options?: FaceProbeOptions) => Promise<FaceProbeReport | null>;
    stop: () => void;
    report: () => FaceProbeReport | null;
    dump: () => string;
    enable: () => void;
    disable: () => void;
    sendProtocol: (protocol: string, payload: unknown, waitMs?: number) => Promise<StepResult>;
    /** 宿主是否提供了合成钩子。 */
    canCompose: () => boolean;
    /** 用最近一次取到的人脸画面合成一整屏，并把预览图写进面板。 */
    composeFrame: () => Promise<{ ok: boolean; width: number; height: number; bytes: number; error?: string }>;
    /** 把一帧画面上传到超星云盘并取回验证；用于确认「页面自行上传」这条路是否可行。 */
    uploadFrame: () => Promise<MonitorUploadResult & { fetchedBack: boolean }>;
    /** 宿主是否提供了上报劫持钩子。 */
    canReplace: () => boolean;
    /** 开关"上报劫持"：开启后客户端的监控回复会被换成我们上传的伪造截屏。 */
    toggleReplacement: () => { installed: boolean; events: ReplacementEvent[] };
    /** 读取/设置“有副作用的步骤发送前确认”。 */
    confirmRisky: (value?: boolean) => boolean;
    /** 上报劫持是否已开启。 */
    replacementInstalled: () => boolean;
    fetchObjectId: (objectId: string) => Promise<{ url: string; ok: boolean; message: string }>;
}

const STORAGE_ENABLE_KEY = 'sw4c-face-probe';
const STORAGE_REPORT_KEY = 'sw4c-face-probe-report';
const URL_FLAG = 'sw4c_face_probe';
const MAX_TRAFFIC = 400;

/** 候选步骤：从最可能唤起悬浮窗的采集开启，到录屏抓拍。 */
function buildSteps(includeScreenMonitor: boolean): ProbeStep[] {
    // 上传参数统一用 JSON 字符串：7.0.4 全部用 optString 读取（对象也能读成 JSON 文本，字符串是规范形态）。
    const faceUpload = JSON.stringify({ uploadtype: 'face_temp' });
    const steps: ProbeStep[] = [
        {
            id: 'face-enable',
            label: '开启人脸采集',
            protocol: 'CLIENT_FACE_COLLECTION',
            payload: {
                enable: 1,
                // 3.6.x 用它，7.0.4 已忽略，留着兼容。
                enableCapture: 1,
                // 7.0.4 会把 <10000 的间隔抬到 10000。
                data: { internalTime: 10_000, funconfig: {} }
            },
            waitMs: 20_000,
            note: '考试页关闭监控就是这条协议的 enable=0 形态；这里试 enable=1，看客户端是否启动采集与悬浮窗。',
            risky: '客户端在“有进行中的监考考试且页面不一致”时会弹提示并关闭当前页'
        },
        {
            id: 'face-enable-upload',
            label: '开启人脸采集（带上传参数）',
            protocol: 'CLIENT_FACE_COLLECTION',
            payload: {
                enable: 1,
                enableCapture: 1,
                data: {
                    internalTime: 10_000,
                    funconfig: {},
                    // 7.0.4 从 data 里读（optString），3.6.x 读顶层；两处都给，字符串形态。
                    uploadParams: faceUpload,
                    faceUploadParam: faceUpload
                },
                uploadParams: faceUpload,
                faceUploadParam: faceUpload
            },
            waitMs: 20_000,
            note: '考试页的 supportCsUploadSwitch 会带上 uploadtype=face_temp；7.0.4 把这两项放在 data 里。',
            risky: '客户端在“有进行中的监考考试且页面不一致”时会弹提示并关闭当前页'
        },
        {
            id: 'face-blink',
            label: '人脸活体采集',
            protocol: 'CLIENT_FACE_RECOGNITION_BLINK',
            payload: {
                // 7.0.4 的功能类型键是 funTag（CreateCourseActivity.G = "funTag"），1 = 采集；
                // 3.6.x 用 funcType，两个都带。
                funTag: 1,
                funcType: 1,
                recogType: 1,
                uploadParams: faceUpload,
                faceUploadParam: faceUpload
            },
            waitMs: 25_000,
            note: 'funTag=1 会拉起全屏人脸采集界面；回包里的 objectIdStr / collectStatus 是真实采集结果。',
            risky: '会拉起全屏相机界面，考试进行中不要点'
        },
        {
            id: 'snapshot',
            label: '启动抓拍',
            protocol: 'CLIENT_SNAPSHOT',
            payload: { type: 3, data: { enable: 1, internalTime: -1, funconfig: {} } },
            waitMs: 20_000,
            note: '考试页检测到悬浮窗时会发这条抓拍；type=4 是重新申请录屏/相机权限，也值得试。'
        }
    ];

    if (includeScreenMonitor) {
        steps.push({
            id: 'screen-monitor',
            label: '启动录屏抓拍（会上传整屏）',
            protocol: 'CLIENT_SCREEN_MONITOR',
            payload: {
                enable: 1,
                controlType: 0,
                internalTime: 5000,
                funconfig: {},
                // cqf.execute 用 optString 读，字符串形态最稳。
                uploadParams: JSON.stringify({ uploadtype: 'examkeeper' })
            },
            waitMs: 25_000,
            note: '客户端用 MediaProjection 截取整屏，悬浮窗属于屏幕内容，因此抓拍图里应当能看到人脸窗；回复里的 objectId 就是整屏截图。',
            risky: '会申请系统录屏授权并上传整屏'
        });
    }

    return steps;
}

/**
 * 当前页面是否像考试页。
 *
 * 7.0.4 的 `CLIENT_FACE_COLLECTION` 在“存在进行中的监考考试、但调用方页面不是那个考试页”时会提示并
 * 关闭当前页。考试页自身带有关系 id / 班级 id 这类隐藏字段，据此判断“页面与考试一致”，从而免去确认。
 */
function looksLikeExamPage(): boolean {
    if (typeof document === 'undefined') return false;
    const markers = ['testUserRelationId', 'examRelationId', 'examId', 'testPaperId', 'classId'];
    if (markers.some((id) => !!document.getElementById(id))) return true;
    return /(?:^|\/)(?:task-exam|exam-ans|do-exam)/i.test(location.pathname);
}

/** 探针是否被开关启用（localStorage 或 URL 参数）。 */
export function faceProbeEnabled(): boolean {
    try {
        if (localStorage.getItem(STORAGE_ENABLE_KEY) === '1') return true;
    } catch {
        // 隐私模式下 localStorage 不可用，退回 URL 判断。
    }
    return location.search.includes(URL_FLAG) || location.hash.includes(URL_FLAG);
}

/**
 * 页面能看到的屏幕与视口指标。
 *
 * 客户端外壳高度取 `screen.height - innerHeight`：在客户端 WebView 里这是状态栏、工具栏与导航栏
 * 之和，正好用来给合成器定档位。
 */
function deviceMetrics(): FaceProbeReport['environment']['metrics'] {
    const screenHeightCss = Math.round(window.screen?.height ?? 0);
    const viewportHeightCss = Math.round(window.innerHeight ?? 0);
    const chrome = screenHeightCss - viewportHeightCss;
    return {
        screenWidthCss: Math.round(window.screen?.width ?? 0),
        screenHeightCss,
        viewportWidthCss: Math.round(window.innerWidth ?? 0),
        viewportHeightCss,
        dpr: window.devicePixelRatio || 1,
        chromeHeightCss: chrome > 0 && chrome < screenHeightCss * 0.4 ? chrome : null
    };
}

/** 序列化，遇到循环引用不抛异常。 */
function serialise(value: unknown): unknown {
    if (typeof value === 'function') return '[function]';
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

/** 从 UA 解析客户端版本串。 */
function parseAppVersion(userAgent: string): string | null {
    const match = userAgent.match(/ChaoXingStudy_([^ ]+)/);
    return match ? match[1] : null;
}

/** 包装 bridge 方法以记录流量，原方法照常执行。 */
function tapBridge(bridge: Record<string, any>, traffic: TrafficEntry[], startedAt: number): void {
    const wrap = (method: string, direction: TrafficEntry['direction']): void => {
        const original = bridge[method];
        if (typeof original !== 'function' || original.__sw4cProbe) return;
        const wrapped = function (this: unknown, ...args: unknown[]) {
            if (traffic.length < MAX_TRAFFIC) {
                traffic.push({
                    elapsedMs: Date.now() - startedAt,
                    direction,
                    protocol: String(args[0]),
                    args: args.slice(1).map(serialise)
                });
            }
            return original.apply(this, args);
        };
        wrapped.__sw4cProbe = true;
        bridge[method] = wrapped;
    };

    wrap('postNotification', 'toClient');
    wrap('trigger', 'toPage');
    wrap('bind', 'bind');
    wrap('unbind', 'unbind');
}

/** 等待 `window.jsBridge` 出现。 */
async function waitForBridge(timeoutMs = 15_000): Promise<Record<string, any> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const bridge = (window as any).jsBridge;
        if (bridge && typeof bridge.postNotification === 'function') return bridge;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
}

/**
 * 安装人脸悬浮窗探针。
 *
 * 注入后立刻挂上流量记录（页面自身在 `_jsBridgeReady` 里发的监控协议也会被记下来），随后按
 * 开关决定是否自动运行候选步骤。
 */
/** 已安装的实例；探针是单例，重复安装不会再建面板或重复发协议。 */
let installed: FaceProbeApi | null = null;
/**
 * 首次安装时的配置对象，之后保持可变。
 *
 * 第二次 `installFaceProbe` 无法重建面板，因此把新给的 `compose` / `objectIdUrl` 等能力合并进来，
 * 让"先注入 bridge、再注入探针"这种顺序也能用。
 */
let installedSettings: FaceProbeOptions | null = null;

export function installFaceProbe(options: FaceProbeOptions = {}): FaceProbeApi {
    if (installed && installedSettings) {
        const target = installedSettings;
        if (options.compose) target.compose = options.compose;
        if (options.objectIdUrl) target.objectIdUrl = options.objectIdUrl;
        if (options.panel === true) target.panel = true;
        if (options.includeScreenMonitor !== undefined) target.includeScreenMonitor = options.includeScreenMonitor;
        if (options.waitScale !== undefined) target.waitScale = options.waitScale;
        // 已经装过：只有明确要求自动运行时才补跑一次。
        if (options.autoRun) void installed.run(options);
        return installed;
    }

    installedSettings = { ...options };
    const settings = installedSettings;
    const startedAt = Date.now();
    const objectIdUrl = (): ((objectId: string) => string) => settings.objectIdUrl ?? DEFAULT_OBJECT_ID_URL;
    const state = {
        running: false,
        stopped: false,
        report: null as FaceProbeReport | null,
        traffic: [] as TrafficEntry[],
        bridge: null as Record<string, any> | null,
        ready: null as Promise<void> | null,
        panel: null as ProbePanel | null,
        /** 最近一次成功取到的人脸画面，供「合成伪造帧」复用。 */
        lastFace: null as HTMLImageElement | null,
        /** 替换事件流水。 */
        replacements: [] as ReplacementEvent[]
    };

    /** 等 bridge、挂流量记录、建报告与面板；重复调用只执行一次。 */
    const ensureReady = (): Promise<void> => {
        if (!state.ready) {
            state.ready = (async () => {
                const bridge = await waitForBridge();
                state.bridge = bridge ?? ((window as any).jsBridge as Record<string, any>) ?? null;
                if (state.bridge) tapBridge(state.bridge, state.traffic, startedAt);

                const report: FaceProbeReport = {
                    startedAt: new Date(startedAt).toISOString(),
                    environment: {
                        pageUrl: location.href,
                        userAgent: navigator.userAgent,
                        metrics: deviceMetrics(),
                        appVersion: parseAppVersion(navigator.userAgent),
                        bridge: (window as any).__STUDY_WOLF__ ? 'study-wolf' : state.bridge ? 'client' : 'unknown',
                        hasWebBridge: !!state.bridge,
                        hasAndroidBridge: !!(window as any).androidjsbridge,
                        androidBridgeKeys: (window as any).androidjsbridge
                            ? Object.keys((window as any).androidjsbridge)
                            : [],
                        device: state.bridge?.device ?? null,
                        isReady: state.bridge?.isReady ?? null,
                        hasCiferaConfig: !!(window as any).__CIFERA__,
                        pageTrafficBeforeProbe: state.traffic.map((entry) => ({ ...entry }))
                    },
                    steps: [],
                    traffic: [],
                    notes: []
                };
                state.report = report;

                if (!state.bridge) {
                    report.notes.push('未找到 window.jsBridge：页面里没有可用的桥，无法测试。');
                } else if ((window as any).androidjsbridge && state.bridge.device !== 'android') {
                    // 直接改字段，避免调 setDevice 触发页面自身的监控引导。
                    state.bridge.device = 'android';
                    report.notes.push('bridge.device 原不是 android，已直接改为 android 以走注入对象通道。');
                }

                if (settings.panel !== false) state.panel = createPanel(api);
                persist(report);
            })();
        }
        return state.ready;
    };

    const run = async (runOptions: FaceProbeOptions = {}): Promise<FaceProbeReport | null> => {
        await ensureReady();
        const report = state.report;
        if (!report || !state.bridge) return report;
        if (state.running) return report;

        state.running = true;
        state.stopped = false;
        report.steps = [];
        report.finishedAt = undefined;

        const scale = runOptions.waitScale ?? settings.waitScale ?? 1;
        const includeScreenMonitor =
            runOptions.includeScreenMonitor ?? settings.includeScreenMonitor ?? true;

        for (const step of buildSteps(includeScreenMonitor)) {
            if (state.stopped) break;
            state.panel?.beginStep(step);
            const result = await runStep(
                state,
                startedAt,
                { ...step, waitMs: Math.round(step.waitMs * scale) },
                objectIdUrl(),
                settings.confirmRisky !== false
            );
            report.steps.push(result);
            state.panel?.render(report);
            persist(report);
            // 已经拿到画面就不再折腾客户端。
            if (result.image) {
                report.notes.push(`步骤 ${step.id} 已拿到画面，后续步骤跳过。`);
                break;
            }
        }

        report.finishedAt = new Date().toISOString();
        report.traffic = state.traffic.map((entry) => ({ ...entry }));
        state.running = false;
        persist(report);
        state.panel?.render(report);
        console.log('[SW4C 人脸探针] 报告', report);
        return report;
    };

    const query = <T extends HTMLElement>(id: string): T =>
        document.getElementById('sw4c-face-probe-panel')?.shadowRoot?.getElementById(id) as T;

    const api: FaceProbeApi = {
        run,
        stop: () => {
            state.stopped = true;
        },
        report: () => state.report,
        dump: () => JSON.stringify(state.report, null, 2),
        enable: () => {
            try {
                localStorage.setItem(STORAGE_ENABLE_KEY, '1');
            } catch {
                // 无法持久化只影响下次自动运行。
            }
        },
        disable: () => {
            try {
                localStorage.removeItem(STORAGE_ENABLE_KEY);
            } catch {
                // 同上。
            }
        },
        sendProtocol: async (protocol, payload, waitMs = 15_000) => {
            await ensureReady();
            return runStep(
                state,
                startedAt,
                {
                    id: `manual-${protocol}`,
                    label: `手动：${protocol}`,
                    protocol,
                    payload,
                    waitMs,
                    note: '面板手动触发'
                },
                objectIdUrl(),
                settings.confirmRisky !== false
            );
        },
        canCompose: () => typeof settings.compose === 'function',
        confirmRisky: (value) => {
            if (value !== undefined) settings.confirmRisky = value;
            return settings.confirmRisky !== false;
        },
        replacementInstalled: () => settings.replaceActive?.() ?? false,
        canReplace: () => typeof settings.startReplace === 'function',
        toggleReplacement: () => {
            if (api.replacementInstalled()) {
                settings.stopReplace?.();
            } else {
                settings.startReplace?.((event) => {
                    state.replacements.push(event);
                    if (state.replacements.length > 50) state.replacements.shift();
                    if (state.report) {
                        state.report.replacements = [...state.replacements];
                        persist(state.report);
                    }
                    state.panel?.renderReplacementEvents();
                });
            }
            const installed = api.replacementInstalled();
            query<HTMLButtonElement>('replace').textContent = installed ? '关闭上报劫持' : '开启上报劫持';
            query<HTMLDivElement>('replaceOut').textContent = installed
                ? '已开启：客户端的监控回复会被换成我们上传的伪造截屏'
                : '未开启：监控回复原样透传';
            return { installed, events: [...state.replacements] };
        },
        uploadFrame: async () => {
            const report = state.report;
            const frame = await buildUploadFrame(state.lastFace);
            // puid 先看页面线索（隐藏输入 / 地址参数），都没有就直接问客户端。
            const puid = await probeResolvePuid(state.bridge);
            const context = pageUploadContext();
            // 页面自己发过的 uploadParams / uploadConfig 直接透传，服务端靠它区分业务类型、决定上传地址。
            const harvested = harvestUploadContext(
                state.traffic
                    .filter((entry) => entry.direction === 'toClient')
                    .map((entry) => entry.args[0])
            );
            const result = await uploadMonitorFrame(frame.blob, {
                ...context,
                uploadUrl: harvested.uploadUrl ?? context.uploadUrl,
                isYunPan: harvested.isYunPan,
                fid: harvested.fid,
                isMirror: harvested.isMirror,
                puid: puid.value ?? context.puid,
                puidSource: puid.source,
                puidTried: puid.tried,
                params: { ...harvested.params, ...(context.params ?? {}) }
            });
            let fetchedBack = false;
            if (result.objectId) {
                try {
                    const image = await loadReadableImage(DEFAULT_OBJECT_ID_URL(result.objectId));
                    fetchedBack = image.naturalWidth > 0;
                    const preview = document.createElement('img');
                    preview.src = image.src;
                    preview.alt = 'uploaded';
                    query<HTMLDivElement>('uploadOut')?.appendChild(preview);
                } catch {
                    fetchedBack = false;
                }
            }
            const outcome = { ...result, fetchedBack };
            if (report) {
                report.upload = outcome;
                persist(report);
                state.panel?.render(report);
            }
            query<HTMLDivElement>('uploadOut')?.insertAdjacentHTML(
                'afterbegin',
                `<div class="${outcome.ok ? 'ok' : 'bad'}">${outcome.ok ? '上传成功' : '上传失败'} · HTTP ${outcome.status} · ${outcome.objectId ?? '无 objectId'} · 取回${fetchedBack ? '成功' : '失败'}<br>puid 来源：${outcome.puidSource ?? '未找到'}</div>`
            );
            return outcome;
        },
        composeFrame: async () => {
            const report = state.report;
            if (!settings.compose) {
                return { ok: false, width: 0, height: 0, bytes: 0, error: '宿主未提供合成钩子' };
            }
            try {
                const canvas = await settings.compose(state.lastFace);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
                const outcome = { ok: true, width: canvas.width, height: canvas.height, bytes };
                if (report) {
                    report.compose = outcome;
                    persist(report);
                    state.panel?.render(report);
                }
                const preview = document.createElement('img');
                preview.src = dataUrl;
                preview.alt = 'composed';
                query<HTMLDivElement>('composeOut').appendChild(preview);
                return outcome;
            } catch (error) {
                const outcome = {
                    ok: false,
                    width: 0,
                    height: 0,
                    bytes: 0,
                    error: error instanceof Error ? error.message : String(error)
                };
                if (report) {
                    report.compose = outcome;
                    persist(report);
                }
                return outcome;
            }
        },
        fetchObjectId: async (objectId) => {
            const url = objectIdUrl()(objectId);
            try {
                await loadReadableImage(url);
                return { url, ok: true, message: '取图成功' };
            } catch (error) {
                return { url, ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        },
        // 不再暴露 getTitle()/getFirstImage() 自检：7.0.4 里它们是 native → JS 的回调名
        // （WebAppViewerFragment.ea()/V9() 会调 androidjsbridge.getFirstImage(src)），不是页面可调用的接口。
        // 注入对象到底有哪些方法，环境区会直接列出 Object.keys(androidjsbridge)。

    };

    installed = api;
    (window as any).__SW4C_FACE_PROBE__ = api;

    // 立刻建好环境与面板：注入后马上就能看到探针在场，不必等第一步跑完。
    void ensureReady();

    // 挂上流量记录后，再按开关决定是否自动运行。
    void (async () => {
        await ensureReady();
        if (settings.autoRun ?? faceProbeEnabled()) await run();
    })();

    return api;
}

/** 执行单个步骤：先发协议，再收集等待窗口内到达的回复。 */
async function runStep(
    state: {
        traffic: TrafficEntry[];
        bridge: Record<string, any> | null;
        lastFace?: HTMLImageElement | null;
    },
    startedAt: number,
    step: ProbeStep,
    objectIdUrl: (objectId: string) => string,
    confirmRisky = true
): Promise<StepResult> {
    const result: StepResult = {
        id: step.id,
        label: step.label,
        protocol: step.protocol,
        note: step.note,
        payload: serialise(step.payload),
        waitMs: step.waitMs,
        replies: []
    };

    const bridge = state.bridge;
    if (!bridge) {
        result.error = '没有可用的 bridge';
        return result;
    }

    // 防关页：有副作用的步骤在非考试页先问一句，用户取消就整步跳过。
    if (step.risky && confirmRisky && !looksLikeExamPage()) {
        const message =
            `即将发送 ${step.protocol}。\n\n风险：${step.risky}。\n\n继续发送吗？`;
        if (typeof window.confirm === 'function' && !window.confirm(message)) {
            result.skipped = `用户取消：${step.risky}`;
            return result;
        }
    }

    // 探针要看客户端原样回的回复，因此在等待窗口内让上报替换放行（否则会被替换管线吞掉）。
    const releaseSuppression = beginMonitorReplacementSuppression();
    const stepStart = Date.now();
    const listener = (payload: unknown): void => {
        result.replies.push({
            protocol: step.protocol,
            type: typeof payload,
            payload: serialise(payload),
            elapsedMs: Date.now() - stepStart
        });
    };

    try {
        bridge.bind(step.protocol, listener);
        bridge.postNotification(step.protocol, step.payload);
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, step.waitMs));

    try {
        bridge.unbind(step.protocol, listener);
    } catch {
        // 解绑失败不影响结论。
    } finally {
        releaseSuppression();
    }

    // 客户端也可能在别的协议上回包（例如状态走 *_STATUS），统一从流量里补齐本步骤窗口内的回复。
    const seen = new Set(result.replies.map((reply) => `${reply.protocol}:${JSON.stringify(reply.payload)}`));
    const windowStart = stepStart - startedAt;
    for (const entry of state.traffic) {
        if (entry.direction !== 'toPage' || entry.elapsedMs < windowStart) continue;
        const key = `${entry.protocol}:${JSON.stringify(entry.args[0])}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.replies.push({
            protocol: entry.protocol,
            type: typeof entry.args[0],
            payload: entry.args[0],
            elapsedMs: entry.elapsedMs
        });
    }

    const candidate = result.replies
        .map((reply) => findFrameCandidate(reply.payload))
        .find((found) => !!found);
    if (candidate) {
        const loadUrl =
            candidate.kind === 'objectId' ? objectIdUrl(candidate.value) : candidate.value;
        result.image = { source: candidate.kind, value: candidate.value, loadUrl, width: 0, height: 0 };
        try {
            const image = await loadReadableImage(loadUrl);
            result.image.width = image.naturalWidth;
            result.image.height = image.naturalHeight;
            if (state.lastFace !== undefined) state.lastFace = image;
        } catch (error) {
            result.error = `已收到画面引用但取图失败：${error instanceof Error ? error.message : String(error)}`;
        }
    }

    return result;
}

/**
 * 准备上传用的帧：优先用合成器产出整屏，没有钩子时退化成一张带文字的占位图。
 *
 * 占位图也够用：这一按钮验证的是"页面能不能自己把图传上去"，而不是画面内容。
 */
async function buildUploadFrame(face: HTMLImageElement | null): Promise<{ blob: Blob }> {
    let canvas: HTMLCanvasElement;
    const composer = (window as any).__SW4C_FACE_PROBE_COMPOSE__;
    if (typeof composer === 'function') {
        canvas = await composer(face);
    } else {
        canvas = document.createElement('canvas');
        canvas.width = 540;
        canvas.height = 960;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#204060';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = '28px monospace';
        ctx.fillText('SW4C upload probe', 24, 48);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('画布编码失败');
    return { blob };
}

/**
 * 探针自己的 puid 解析：先用页面线索，再问客户端。
 *
 * 刻意不走 bridge 模块里的实现——那会把整个 bridge 拖进独立探针产物，还会顶掉页面已有的 bridge。
 */
async function probeResolvePuid(
    bridge: Record<string, any> | null
): Promise<{ value: string | null; source: string | null; tried: string[] }> {
    const fromPage = resolvePuid();
    if (fromPage.value || !bridge) return fromPage;

    const tried = [...fromPage.tried];
    for (const protocol of ['CLIENT_GET_USERINFO', 'CLIENT_LOGIN_STATUS']) {
        let resolveReply: ((reply: unknown) => void) | null = null;
        const received = new Promise<unknown>((resolve) => {
            resolveReply = resolve;
        });
        const listener = (payload: unknown): void => resolveReply?.(payload);
        try {
            bridge.bind(protocol, listener);
            bridge.postNotification(protocol, {});
            const reply = await Promise.race([
                received,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
            ]);
            tried.push(`client:${protocol}`);
            if (reply) {
                const found = findPuidInReply(reply);
                if (found.value) {
                    return { value: found.value, source: `client:${protocol}#${found.field}`, tried };
                }
            }
        } catch {
            // 客户端不接受这条协议就换下一条。
        } finally {
            try {
                bridge.unbind(protocol, listener);
            } catch {
                // 解绑失败不影响结论。
            }
        }
    }

    tried.push('client:均无 puid');
    return { value: null, source: null, tried };
}

/** 写回 localStorage，便于页面跳转后仍能取到记录。 */
function persist(report: FaceProbeReport): void {
    try {
        localStorage.setItem(STORAGE_REPORT_KEY, JSON.stringify(report));
    } catch {
        // 报告过大或存储不可用时忽略：面板与 console 仍在。
    }
}

/** 页面面板。 */
interface ProbePanel {
    beginStep: (step: ProbeStep) => void;
    render: (report: FaceProbeReport) => void;
    /** 只重画上报劫持的事件流水。 */
    renderReplacementEvents: () => void;
    /** 从页面上移除面板。 */
    remove: () => void;
}

/** 创建面板；样式放在 shadow DOM 内，避免与页面互相影响。 */
function createPanel(api: FaceProbeApi): ProbePanel {
    const host = document.createElement('div');
    host.id = 'sw4c-face-probe-panel';
    // 标记成插件节点：合成伪造帧时 SnapDOM 会排除它（见 fake-screen 的 SW4C_MARK_SELECTOR）。
    host.setAttribute('data-sw4c', 'probe-panel');
    host.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: absolute; top: 8px; right: 8px; width: 344px; max-height: 86vh; overflow: auto;
                font: 12px/1.5 monospace; color: #e8e8e8; background: rgba(18,18,20,.96);
                border: 1px solid #4a4a52; border-radius: 8px; pointer-events: auto;
                box-shadow: 0 6px 24px rgba(0,0,0,.5); }
        .wrap.full { top: 0; right: 0; bottom: 0; left: 0; width: auto; max-height: none; border-radius: 0; }
        header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #26262c;
                 border-radius: 8px 8px 0 0; position: sticky; top: 0; }
        header b { flex: 1; }
        section { padding: 8px 10px; border-top: 1px solid #34343c; }
        .ok { color: #7d7; } .bad { color: #f88; } .dim { color: #999; }
        pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; color: #ccc; }
        button { font: 13px monospace; color: #eee; background: #33333a; border: 1px solid #55555f;
                 border-radius: 6px; padding: 8px 10px; margin: 3px 3px 0 0; cursor: pointer; }
        textarea { width: 100%; height: 190px; margin-top: 4px; box-sizing: border-box;
                   font: 11px/1.4 monospace; color: #ddd; background: #16161a;
                   border: 1px solid #55555f; border-radius: 6px; padding: 6px; }
        img { max-width: 100%; border: 1px solid #55555f; border-radius: 4px; margin-top: 4px; }
        input { width: 170px; font: 12px monospace; background: #22222a; color: #eee;
                border: 1px solid #55555f; border-radius: 4px; padding: 6px; }
      </style>
      <div class="wrap" id="wrap">
        <header><b>人脸悬浮窗探针</b><span id="status" class="dim">初始化…</span></header>
        <div id="body">
          <section id="env"></section>
          <section id="steps"><div class="dim">等待开始</div></section>
          <section>
            <label><input type="checkbox" id="confirmRisky" checked> 非考试页发送前确认（防关页）</label>
            <button id="full">全屏</button>
            <button id="copy">复制 JSON</button>
            <button id="rerun">重跑</button>
            <button id="stop">停止</button>
            <button id="close">关闭探针</button>
          </section>
          <section id="composeSection" hidden>
            <div class="dim">合成伪造帧（用真实摄像头画面 + 页面 + 系统栏拼出一整屏）</div>
            <button id="compose">合成伪造帧</button>
            <div id="composeOut" class="dim"></div>
          </section>
          <section>
            <div class="dim">上报自测（会把当前这帧画面上传到超星云盘，用于确认页面能否自行上传）</div>
            <button id="upload">上传伪造帧</button>
            <div id="uploadOut" class="dim"></div>
          </section>
          <section id="replaceSection" hidden>
            <div class="dim">上报劫持（开启后：客户端监控回复里的 objectId 会被换成我们上传的伪造截屏）</div>
            <button id="replace">开启上报劫持</button>
            <div id="replaceOut" class="dim">未开启：监控回复原样透传</div>
          </section>
          <section>
            <div class="dim">完整 JSON（长按可选中复制；也可以直接截这一段图）</div>
            <textarea id="json" readonly></textarea>
          </section>
          <section>
            <div class="dim">objectId 取图验证</div>
            <input id="objectId" placeholder="粘贴 objectId">
            <button id="fetch">取图</button>
            <div id="fetchOut" class="dim"></div>
          </section>
        </div>
      </div>`;

    document.documentElement.appendChild(host);

    const query = <T extends HTMLElement>(id: string): T => shadow.getElementById(id) as T;
    const wrap = query<HTMLDivElement>('wrap');
    const status = query<HTMLSpanElement>('status');
    const objectIdInput = query<HTMLInputElement>('objectId');
    const jsonBox = query<HTMLTextAreaElement>('json');
    const fetchOut = query<HTMLDivElement>('fetchOut');

    /** 把报告同步进文本框：没有检查器时，长按选中复制就是唯一的取回方式。 */
    const syncJson = (): void => {
        jsonBox.value = api.dump();
    };

    query<HTMLButtonElement>('full').addEventListener('click', () => {
        wrap.classList.toggle('full');
        syncJson();
    });
    query<HTMLButtonElement>('copy').addEventListener('click', () => {
        syncJson();
        jsonBox.select();
        navigator.clipboard?.writeText(jsonBox.value).then(
            () => (status.textContent = '已复制'),
            () => (status.textContent = '请长按文本框复制')
        );
    });
    query<HTMLInputElement>('confirmRisky').checked = api.confirmRisky();
    query<HTMLInputElement>('confirmRisky').addEventListener('change', (event) => {
        api.confirmRisky((event.target as HTMLInputElement).checked);
    });
    query<HTMLButtonElement>('rerun').addEventListener('click', () => void api.run());
    query<HTMLButtonElement>('stop').addEventListener('click', () => {
        api.stop();
        status.textContent = '已停止';
    });
    query<HTMLButtonElement>('close').addEventListener('click', () => {
        api.stop();
        host.remove();
    });
    // 合成区按宿主能力显示：能力可能在面板建好之后才补进来，所以每次渲染都会重算。
    const syncComposeSection = (): void => {
        query<HTMLElement>('composeSection').hidden = !api.canCompose();
    };
    if (api.canCompose()) {
        query<HTMLButtonElement>('compose').addEventListener('click', async () => {
            const out = query<HTMLDivElement>('composeOut');
            out.textContent = '合成中…';
            const outcome = await api.composeFrame();
            out.textContent = outcome.ok
                ? `成功：${outcome.width}x${outcome.height}，JPEG ${Math.round(outcome.bytes / 1024)} KB`
                : `失败：${outcome.error}`;
        });
    }

    query<HTMLButtonElement>('replace').addEventListener('click', () => {
        api.toggleReplacement();
    });

    query<HTMLButtonElement>('upload').addEventListener('click', async () => {
        query<HTMLDivElement>('uploadOut').textContent = '上传中…';
        await api.uploadFrame();
    });

    query<HTMLButtonElement>('fetch').addEventListener('click', async () => {
        const value = objectIdInput.value.trim();
        if (!value) return;
        const out = await api.fetchObjectId(value);
        fetchOut.textContent = `${out.ok ? '成功' : '失败'}：${out.url}`;
    });

    /** 把替换事件流水画出来；宿主没提供劫持钩子时整区隐藏。 */
    const renderReplacementEvents = (): void => {
        const section = query<HTMLElement>('replaceSection');
        if (section) section.hidden = !api.canReplace();
        const button = query<HTMLButtonElement>('replace');
        if (button) button.textContent = api.replacementInstalled() ? '关闭上报劫持' : '开启上报劫持';
        const out = query<HTMLDivElement>('replaceOut');
        if (!out) return;
        const events = (api.report()?.replacements ?? []).slice(-6).reverse();
        out.innerHTML = [
            api.replacementInstalled() ? '已开启：客户端的监控回复会被换成我们上传的伪造截屏' : '未开启：监控回复原样透传',
            ...events.map(
                (event) =>
                    `<div class="${event.ok ? 'ok' : 'bad'}">${event.protocol} · ${event.ok ? '已替换' : '未替换'} · ${event.objectId ?? ''} ${event.reason ?? ''} · ${event.elapsedMs}ms</div>`
            )
        ].join('');
    };

    const render = (report: FaceProbeReport): void => {
        syncComposeSection();
        renderReplacementEvents();
        const env = report.environment;
        query<HTMLDivElement>('env').innerHTML = `
          <div>bridge：<span class="${env.hasWebBridge ? 'ok' : 'bad'}">${env.bridge}</span>
               ${env.hasAndroidBridge ? '· 有原生接口' : '· <span class="bad">无原生接口</span>'}</div>
          <div>device：${env.device ?? '-'} · isReady：${String(env.isReady)} · Cifera：${env.hasCiferaConfig ? '是' : '否'}</div>
          <div class="dim">屏幕：${env.metrics.screenWidthCss}x${env.metrics.screenHeightCss} @${env.metrics.dpr}x ·
               视口：${env.metrics.viewportWidthCss}x${env.metrics.viewportHeightCss} ·
               外壳：${env.metrics.chromeHeightCss ?? '未知'} px</div>
          <div class="dim">版本：${env.appVersion ?? '未知'}</div>
          <div class="dim">原生方法：${env.androidBridgeKeys.join(', ') || '无'}</div>
          <div class="dim">启动前页面已发：${env.pageTrafficBeforeProbe
              .filter((entry) => entry.direction === 'toClient')
              .map((entry) => entry.protocol)
              .join(', ') || '无'}</div>
          ${report.notes.map((note) => `<div class="dim">· ${note}</div>`).join('')}`;

        query<HTMLDivElement>('steps').innerHTML = report.steps
            .map((step) => {
                const replies = step.skipped
                    ? `<span class="bad">已跳过</span>`
                    : step.replies.length
                      ? `<span class="ok">收到 ${step.replies.length} 条</span>`
                      : '<span class="bad">无回复</span>';
                const skipped = step.skipped ? `<div class="bad">${step.skipped}</div>` : '';
                const image = step.image && step.image.width
                    ? `<div>画面：${step.image.source} ${step.image.width}x${step.image.height}</div>
                       <img src="${step.image.loadUrl}">`
                    : step.image
                      ? `<div class="bad">画面引用取图失败：${step.image.source}</div>`
                      : '';
                const error = step.error ? `<div class="bad">${step.error}</div>` : '';
                const payload = step.replies.length
                    ? `<pre>${JSON.stringify(step.replies.map((reply) => ({ t: reply.type, ms: reply.elapsedMs, p: reply.payload }))).slice(0, 700)}</pre>`
                    : '';
                return `<div style="margin-bottom:8px"><div>${step.label} ${replies}</div>${skipped}${image}${error}${payload}</div>`;
            })
            .join('') || '<div class="dim">等待开始</div>';

        const answered = report.steps.filter((step) => step.replies.length).length;
        status.textContent = report.finishedAt
            ? answered
                ? `完成：${answered}/${report.steps.length} 步有回复`
                : '完成：全部无回复'
            : `进行中：已完成 ${report.steps.length} 步`;

        syncJson();
    };

    render(api.report() ?? emptyReport());
    syncJson();
    syncComposeSection();

    return {
        beginStep: () => {
            status.textContent = '进行中…';
        },
        render,
        renderReplacementEvents,
        remove: () => host.remove()
    };
}

/** 面板首次渲染时报告还没建好，先用空壳占位。 */
function emptyReport(): FaceProbeReport {
    return {
        startedAt: new Date().toISOString(),
        environment: {
            pageUrl: location.href,
            userAgent: navigator.userAgent,
            metrics: deviceMetrics(),
            appVersion: null,
            bridge: 'unknown',
            hasWebBridge: false,
            hasAndroidBridge: false,
            androidBridgeKeys: [],
            device: null,
            isReady: null,
            hasCiferaConfig: false,
            pageTrafficBeforeProbe: []
        },
        steps: [],
        traffic: [],
        notes: []
    };
}

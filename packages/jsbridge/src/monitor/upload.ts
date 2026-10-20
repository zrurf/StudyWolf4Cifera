import { rewriteUrl } from '../utils/proxy_url.js';

/**
 * 把伪造帧传到超星云盘，换回可以回填给页面的 objectId。
 *
 * 依据（客户端 3.6.7.7 反编译 `UploadTask.java`）：客户端自己的上传是 multipart POST，表单**只有**
 * `file` 与 `puid` 两个字段，查询参数直接来自页面请求里带的 `uploadParams`（抓前置摄像头时再叠加
 * `faceUploadParam`）；地址优先用 `uploadConfig.uploadUrl`（页面里的 `#workExamUploadUrl`，由后端注
 * 入），为空则回落到云盘中心 `https://pan-yz.chaoxing.com/upload`；响应里的 `data.objectId` 就是客
 * 户端随后回传给页面的那个 id。
 *
 * 页面本身只上报元数据（objectId），二进制始终由客户端上传。所以要替换画面，只能由页面把伪造帧自己
 * 传上去，再把客户端回复里的 objectId 换成自己的。
 */

/** 云盘中心上传接口；`uploadConfig.uploadUrl` 为空时客户端走的就是这里。 */
export const DEFAULT_PAN_UPLOAD_URL = 'https://pan-yz.chaoxing.com/upload';

/** 上传需要的上下文，多数可以直接从页面里读出来。 */
export interface MonitorUploadContext {
    /** 后端注入的上传地址；为空则用云盘中心。 */
    uploadUrl?: string;
    /** 查询参数：原样透传页面请求里的 `uploadParams` / `faceUploadParam`。 */
    params?: Record<string, string>;
    /** 账号 id（`puid`）。客户端从账号管理器取；页面可从 URL 的 `userId` 得到。 */
    puid?: string;
    /** 云盘镜像用的 fid；`isYunPan` 为真时用它拼镜像域名。 */
    fid?: string;
    isYunPan?: boolean;
    isMirror?: number;
    /** `puid` 的来源（`pageUploadContext` 会填），用于诊断。 */
    puidSource?: string | null;
    /** 尝试过的 `puid` 来源列表。 */
    puidTried?: string[];
}

/** 一次上传的结果。 */
export interface MonitorUploadResult {
    ok: boolean;
    /** 成功时服务端给的云盘 id。 */
    objectId: string | null;
    status: number;
    /** 服务端响应原文（截断），失败时用于排查。 */
    body: string;
    /** 实际请求的地址（含查询串）。 */
    url: string;
    /** `puid` 命中的来源；为空说明没找到，服务端一定会拒。 */
    puidSource?: string | null;
    /** 尝试过的 `puid` 来源列表，便于补候选。 */
    puidTried?: string[];
}

/**
 * 账号 id（`puid`）的候选来源，按可靠性排序。
 *
 * 服务端会直接校验它（实测报错 `参数错误, puid不能为空, null`），而它在页面上的落点随业务页面而变，
 * 因此逐个尝试并把命中的来源记下来，方便在别的页面上补候选。
 *
 * 注意：不要用 `cxcid` 的尾部去猜。实测 `cxcid = 3e57ec8c74669bf1ad3d28be5badd309410191884` 里哈希
 * 尾部与账号 id 连成了 12 位数字，按"末尾数字串"截会得到 `309410191884`，那是错的账号，上传会被记到别
 * 人名下。拿不到就直接让客户端回答（见 `client-info.ts`）。
 */
const PUID_INPUT_IDS = ['puid', 'userId', 'personId', 'uid', 'userid'];
const PUID_QUERY_KEYS = ['userId', 'puid', 'personId', 'uid'];

/** `puid` 解析结果。 */
export interface PuidResolution {
    value: string | null;
    /** 命中的来源，例如 `input:userId`、`url:userId`、`client:CLIENT_GET_USERINFO#puid`。 */
    source: string | null;
    /** 试过但没值的来源，便于排查。 */
    tried: string[];
}

/**
 * 找出账号 id。
 *
 * 客户端取的是账号管理器里的 `puid`；页面上等价的候选是隐藏输入与地址参数里的 `userId`/`personId`。
 * 另外客户端回包里的 `cxcid` 以账号 id 结尾（实测 `...410191884` 与 URL 的 `userId` 一致），因此把
 * 它作为最后一道兜底。
 */
export function resolvePuid(options: { root?: Document } = {}): PuidResolution {
    const root = options.root ?? (typeof document === 'undefined' ? undefined : document);
    const tried: string[] = [];

    for (const id of PUID_INPUT_IDS) {
        tried.push(`input:${id}`);
        const element = root?.getElementById(id) as HTMLInputElement | null | undefined;
        const raw = element?.value?.trim();
        if (raw) return { value: raw, source: `input:${id}`, tried };
    }

    if (typeof location !== 'undefined') {
        try {
            const search = new URL(location.href).searchParams;
            for (const key of PUID_QUERY_KEYS) {
                tried.push(`url:${key}`);
                const raw = search.get(key)?.trim();
                if (raw) return { value: raw, source: `url:${key}`, tried };
            }
        } catch {
            tried.push('url:parse-error');
        }
    }

    return { value: null, source: null, tried };
}

/**
 * 从页面里读出上传上下文。
 *
 * 上传地址由后端注入在 `#workExamUploadUrl` 里；账号 id 见 {@link resolvePuid}，页面里找不到时由
 * `client-info.ts` 去问客户端。
 */
export function pageUploadContext(root?: Document): MonitorUploadContext {
    const doc = root ?? (typeof document === 'undefined' ? undefined : document);
    const value = (id: string): string | undefined => {
        const element = doc?.getElementById(id) as HTMLInputElement | null | undefined;
        const raw = element?.value?.trim();
        return raw ? raw : undefined;
    };

    const puid = resolvePuid({ root: doc });

    return {
        uploadUrl: value('workExamUploadUrl'),
        puid: puid.value ?? undefined,
        params: {}
    };
}

/** 从监控请求里回收的上传上下文。 */
export interface HarvestedUpload {
    /** 合并后的查询参数（`uploadParams` 与 `faceUploadParam`）。 */
    params: Record<string, string>;
    /** 页面给的 `uploadConfig.uploadUrl`；后端按场次注入，优先于隐藏输入与云盘中心。 */
    uploadUrl?: string;
    isYunPan?: boolean;
    fid?: string;
    isMirror?: number;
}

/** 只出现在上传参数里的键。 */
const UPLOAD_PARAM_KEYS = ['uploadParams', 'faceUploadParam'] as const;

/** 把对象或 JSON 字符串统一读成对象；不是对象返回 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value === 'string' && value.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(value) as unknown;
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * 从页面发过的监控请求里回收上传上下文。
 *
 * 客户端 7.0.4 的字段位置并不统一：`CLIENT_SCREEN_MONITOR` 把 `uploadParams` / `uploadConfig` 放在顶层，
 * 而 `CLIENT_FACE_COLLECTION` 与 `CLIENT_SNAPSHOT` 放在 `data` 里。只读顶层会漏掉后两者，导致上传时缺少
 * `uploadtype` 这类业务参数。`uploadConfig` 本身还是 JSON 字符串，需要解析后才能拿到 `uploadUrl`
 * （客户端就是用它决定上传去哪的）。
 *
 * @param payloads - 依次传入的请求载荷，后出现的覆盖先出现的同名参数。
 */
export function harvestUploadContext(payloads: unknown[]): HarvestedUpload {
    const result: HarvestedUpload = { params: {} };

    for (const payload of payloads) {
        const root = asRecord(payload);
        if (!root) continue;

        for (const container of [root, asRecord(root.data)]) {
            if (!container) continue;

            for (const key of UPLOAD_PARAM_KEYS) {
                const params = asRecord(container[key]);
                if (!params) continue;
                for (const [name, value] of Object.entries(params)) {
                    if (typeof value === 'string' || typeof value === 'number') {
                        result.params[name] = String(value);
                    }
                }
            }

            const config = asRecord(container.uploadConfig);
            if (!config) continue;
            if (typeof config.uploadUrl === 'string' && config.uploadUrl.trim()) {
                result.uploadUrl = config.uploadUrl.trim();
            }
            if (typeof config.fid === 'string' && config.fid.trim()) result.fid = config.fid.trim();
            if (config.isYunPan !== undefined) result.isYunPan = Number(config.isYunPan) === 1;
            if (config.isMirror !== undefined) result.isMirror = Number(config.isMirror);
        }
    }

    return result;
}

/** 按上下文拼出实际上传地址。 */
function resolveUploadUrl(context: MonitorUploadContext): string {
    if (context.uploadUrl) return context.uploadUrl;
    if (context.isYunPan && context.fid) return `https://${context.fid}-pan.chaoxing.com/upload`;
    return DEFAULT_PAN_UPLOAD_URL;
}

/**
 * 上传一帧画面。
 *
 * 请求经 Cifera 改写成同源地址后发出，因此带上页面自身的会话；`params` 里应把页面请求里的
 * `uploadParams`（前置画面再加 `faceUploadParam`）原样带上，服务端靠它区分业务类型。
 *
 * @param frame - JPEG/PNG 二进制。
 * @param context - 上传上下文，默认从当前页面读。
 * @param options - `filename` 与自定义 `fetchImpl`。
 * @returns 服务端结果；`objectId` 可直接用于回填页面收到的监控回复。
 */
export async function uploadMonitorFrame(
    frame: Blob,
    context: MonitorUploadContext = pageUploadContext(),
    options: { filename?: string; fetchImpl?: typeof fetch } = {}
): Promise<MonitorUploadResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    if (!context.puid) {
        return {
            ok: false,
            objectId: null,
            status: 0,
            body: `puid 为空，服务端必然拒绝；已尝试：${(context.puidTried ?? []).join(', ') || '无'}`,
            url: resolveUploadUrl(context),
            puidSource: null,
            puidTried: context.puidTried
        };
    }
    const target = new URL(resolveUploadUrl(context));
    for (const [key, value] of Object.entries(context.params ?? {})) {
        if (value !== undefined && value !== null && value !== '') {
            target.searchParams.set(key, String(value));
        }
    }

    const form = new FormData();
    form.append('file', frame, options.filename ?? `monitor_${Date.now()}.jpg`);
    if (context.puid) form.append('puid', String(context.puid));

    const url = rewriteUrl(target.toString());
    const meta = { puidSource: context.puidSource ?? null, puidTried: context.puidTried };
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            body: form,
            credentials: 'include'
        });
        const text = await response.text();
        let objectId: string | null = null;
        try {
            const parsed = JSON.parse(text) as { data?: { objectId?: string } };
            objectId = parsed?.data?.objectId ?? null;
        } catch {
            objectId = null;
        }
        return {
            ok: response.ok && !!objectId,
            objectId,
            status: response.status,
            body: text.slice(0, 500),
            url,
            ...meta
        };
    } catch (error) {
        return {
            ok: false,
            objectId: null,
            status: 0,
            body: error instanceof Error ? error.message : String(error),
            url,
            ...meta
        };
    }
}

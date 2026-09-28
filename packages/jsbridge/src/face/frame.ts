/**
 * 从客户端回复中提取画面、以及把画面读成可绘制对象的纯函数。
 *
 * 不导入有 bridge 初始化副作用的模块，便于合成器与测试独立复用。
 */

/** 从回复里找到的画面候选。 */
export interface FrameCandidate {
    kind: 'data' | 'url' | 'objectId';
    value: string;
}

/**
 * objectId 字段，按优先级从具体到宽泛排列。
 *
 * 真机回复里同时带 `frontObjectId`（前置，人脸）与 `backObjectId`（后置），因此前置必须排在前面：
 * 合成悬浮窗要的是人脸那一路。替换上报结果时也按这份名单逐字段改写。
 */
export const OBJECT_ID_KEYS = [
    'captureObjectId',
    'frontObjectId',
    'objectId',
    'objectIdStr',
    'backObjectId'
];

/**
 * objectId 转图片 URL 的默认模板。
 *
 * 已实测（2026-09-24，客户端 3.6.7.7_10945_315）：抓拍回复里的 `frontObjectId` 用该模板取到了
 * 540x960 的真实人脸图，因此默认值可用；需要换云盘域名时再用 `objectIdUrl` 覆盖。
 *
 * 客户端偶尔会在回复里直接给出完整 URL，那种情况优先使用完整 URL。
 */
export const DEFAULT_OBJECT_ID_URL = (objectId: string) =>
    `https://p.ananas.chaoxing.com/star3/origin/${objectId}`;

/** 是否是内嵌图片。 */
function isInlineImage(value: string): boolean {
    return /^data:image\//i.test(value);
}

/** 是否是可用的远程图片地址。 */
function isImageUrl(value: string): boolean {
    return /^https?:\/\//i.test(value) && /\.(jpe?g|png|webp)(\?|$)/i.test(value);
}

/** 是否像超星云盘的 objectId。 */
function isObjectId(value: string): boolean {
    return /^[0-9a-f]{16,64}$/i.test(value);
}

/**
 * 找出回复里第一个可用的画面引用。
 *
 * 内嵌数据优先于 URL、URL 优先于 objectId；同层字段优先于深层字段，因此同时带预览图和
 * 存储 id 的回复会直接给出像素。
 */
export function findFrameCandidate(reply: unknown): FrameCandidate | null {
    const queue: unknown[] = [reply];
    const seen = new Set<unknown>();
    let objectId: FrameCandidate | null = null;

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        for (const [key, raw] of Object.entries(current as Record<string, unknown>)) {
            if (typeof raw === 'string') {
                if (isInlineImage(raw)) return { kind: 'data', value: raw };
                if (isImageUrl(raw)) return { kind: 'url', value: raw };
                if (!objectId && OBJECT_ID_KEYS.includes(key) && isObjectId(raw)) {
                    objectId = { kind: 'objectId', value: raw };
                }
            } else if (raw && typeof raw === 'object') {
                queue.push(raw);
            }
        }
    }

    return objectId;
}

/** 载入图片，使其可以被绘制到 canvas 而不污染画布。 */
export async function loadReadableImage(
    url: string,
    rewrite: (url: string) => string = (value) => value
): Promise<HTMLImageElement> {
    const source = url.startsWith('data:') ? url : rewrite(url);
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    await image.decode();
    return image;
}

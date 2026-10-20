import { OBJECT_ID_KEYS } from '../face/frame.js';

/**
 * 上报改写用的纯函数。
 *
 * 与 DOM、bridge 都无关，因此可以在没有浏览器的环境里单独测试：替换 objectId 的规则、以及从客户端
 * 回复里找账号 id 的规则都不该藏在带副作用的模块里。
 */

/** 回包里可能承载 `puid` 的字段名，按优先级排列。 */
const PUID_FIELDS = ['puid', 'uid', 'userId', 'userid', 'personId', 'personid', 'id'];

/** 一个像账号 id 的值：数字串，长度至少 6。 */
function looksLikePuid(value: unknown): value is string | number {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 100000;
    return typeof value === 'string' && /^\d{6,}$/.test(value.trim());
}

/**
 * 从客户端回包里找出账号 id。
 *
 * 广度优先：浅层字段优先，同层按 {@link PUID_FIELDS} 的顺序，因此 `{puid: 123}` 会赢过
 * `{data: {userId: 456}}`。
 */
export function findPuidInReply(reply: unknown): { value: string | null; field: string | null } {
    const queue: unknown[] = [reply];
    const seen = new Set<unknown>();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        const record = current as Record<string, unknown>;
        for (const field of PUID_FIELDS) {
            const raw = record[field];
            if (looksLikePuid(raw)) return { value: String(raw), field };
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === 'object') queue.push(value);
        }
    }

    return { value: null, field: null };
}

/**
 * 就地改写载荷里的 objectId 字段。
 *
 * 字段名单与"从回复里找画面"共用（{@link OBJECT_ID_KEYS}），因此前后置、抓拍、录屏几种回复都能一次
 * 换掉。
 *
 * @returns 改写成功的字段数；为 0 说明这份回复没有可换的画面引用。
 */
export function rewriteObjectIds(payload: unknown, objectId: string): number {
    let replaced = 0;
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        const record = current as Record<string, unknown>;
        for (const [key, value] of Object.entries(record)) {
            if (typeof value === 'string' && OBJECT_ID_KEYS.includes(key)) {
                record[key] = objectId;
                replaced++;
            } else if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return replaced;
}

/**
 * 移除载荷里的 `signToken`。
 *
 * 客户端的签名是对它自己的 objectId 计算的；我们把 id 换掉之后原签名必然失配，留着只会让服务端判定
 * “签名错误”，删掉等同于旧版客户端的不带签名上报。
 *
 * @returns 移除的字段数。
 */
export function dropSignatureFields(payload: unknown): number {
    let removed = 0;
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        const record = current as Record<string, unknown>;
        if (typeof record.signToken === 'string') {
            delete record.signToken;
            removed++;
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === 'object') queue.push(value);
        }
    }

    return removed;
}

/**
 * 回复里是否带内联图片。
 *
 * 客户端 7.0.4 的 `CLIENT_SNAPSHOT` 有一部分路径不回 objectId，而是把图片 base64 直接塞进
 * `files[].data` 交给页面。这种回复同样要换成伪造帧，否则页面拿到的是真实画面。
 */
export function hasInlineImageFiles(payload: unknown): boolean {
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        const record = current as Record<string, unknown>;
        const files = record.files;
        if (Array.isArray(files)) {
            for (const file of files) {
                const entry = file as Record<string, unknown> | null;
                if (entry && typeof entry.data === 'string' && entry.data.length > 64) return true;
            }
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === 'object') queue.push(value);
        }
    }

    return false;
}

/**
 * 把 `files[].data` 里的 base64 图片换掉。
 *
 * 只改 `files` 数组里的 `data` 字符串，其它结构（`name`/`type`、以及路径字符串形态的 `files`）保持原样。
 *
 * @returns 替换的条目数。
 */
export function rewriteInlineImages(payload: unknown, base64: string): number {
    let replaced = 0;
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        const record = current as Record<string, unknown>;

        if (Array.isArray(record.files)) {
            for (const file of record.files) {
                const entry = file as Record<string, unknown> | null;
                if (!entry || typeof entry.data !== 'string' || entry.data.length <= 64) continue;
                entry.data = base64;
                replaced++;
            }
        }

        for (const value of Object.values(record)) {
            if (value && typeof value === 'object') queue.push(value);
        }
    }

    return replaced;
}

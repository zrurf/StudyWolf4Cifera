/**
 * `requestFaceFrame` 的浏览器测试。
 *
 * 桩客户端用真机抓到的回包（docs/chaoxing.txt）作答，验证：绑定 → 发协议 → 解析 objectId →
 * 取图 → 停止采集 这条链路，以及 9:16 抓拍图能落到调用方手里。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium, type Browser } from 'playwright-core';

const EDGE_PATHS = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome'
].filter((entry): entry is string => !!entry);

/** 单色 PNG（540x960 太大，这里只用于验证取图链路）。 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc32 = (bytes: Uint8Array): number => {
        let c = 0xffffffff;
        for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        out.set(new TextEncoder().encode(type), 4);
        out.set(data, 8);
        view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
        return out;
    };
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = new Uint8Array(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
        const rowStart = y * (1 + width * 3);
        for (let x = 0; x < width; x++) {
            const pixel = rowStart + 1 + x * 3;
            raw[pixel] = rgb[0];
            raw[pixel + 1] = rgb[1];
            raw[pixel + 2] = rgb[2];
        }
    }
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array(0))
    ];
    const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
    }
    return merged;
}

const FACE_PNG = solidPng(54, 96, [0x33, 0x88, 0xcc]);
const FRONT_OBJECT_ID = 'eb22bddf7ffee338164f3ca4e8df5702';

/** 真机回包（节选自 docs/chaoxing.txt）。 */
const REAL_REPLY = {
    data: {
        picCollectTime: 1790256242813,
        frontStatus: 1,
        frontObjectId: FRONT_OBJECT_ID,
        completeTime: 1790256248390,
        backStatus: 1,
        backObjectId: '06c639617c223448960c0a9d04cff465',
        funconfig: '{}'
    },
    captureMode: 0,
    signToken: 'a38b3dcbbb19f4bd926ec4e10429ca09',
    cxcid: '3e57ec8c74669bf1ad3d28be5badd309410191884',
    cxtime: '1790256248390'
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let bridgeSource = '';

const ORIGIN = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, '..', 'src', 'index.ts')],
        target: 'browser',
        format: 'esm',
        minify: false
    });
    if (!build.success) throw new Error('bridge bundle failed: ' + build.logs.map(String).join('\n'));
    bridgeSource = await build.outputs[0].text();

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/bridge.js') {
                return new Response(bridgeSource, { headers: { 'content-type': 'application/javascript' } });
            }
            if (url.pathname === '/face.png') {
                return new Response(FACE_PNG, { headers: { 'content-type': 'image/png' } });
            }
            return new Response(
                `<!doctype html><html><head><meta charset="utf-8">
                 <script>
                   // 桩客户端：收到采集请求后按真机回包作答，并记录客户端收到的协议。
                   window.__toClient__ = [];
                   window.androidjsbridge = {
                     postNotification: function (name, payload) {
                       window.__toClient__.push({ name: name, payload: JSON.parse(payload) });
                       if (name === 'CLIENT_FACE_COLLECTION') {
                         var payloadObj = JSON.parse(payload);
                         // 客户端用 optInt 判定，字符串与数字都算；桩也照做。
                         if (String(payloadObj.enable) === '1') {
                           setTimeout(function () {
                             window.jsBridge.trigger('CLIENT_FACE_COLLECTION', ${JSON.stringify(REAL_REPLY)});
                           }, 10);
                         }
                       }
                     }
                   };
                 </script>
                 <script type="module">
                   import * as Lib from '/bridge.js';
                   window.__Lib__ = Lib;
                 </script>
                 </head><body>人脸取帧测试页</body></html>`,
                { headers: { 'content-type': 'text/html' } }
            );
        }
    });

    const executablePath = EDGE_PATHS.find((candidate) => Bun.file(candidate).size > 0);
    if (!executablePath) throw new Error('no Edge/Chrome binary found for browser tests');
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

describe('requestFaceFrame', () => {
    test('用真机回包解析出前置画面，取完图后请求客户端停止采集', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async ({ frontObjectId }) => {
            // 桥默认 device 为 ios，这里按真机情形切成注入对象通道。
            (window as any).jsBridge.device = 'android';
            const result = await (window as any).__Lib__.requestFaceFrame({
                timeoutMs: 5000,
                internalTimeMs: 1000,
                objectIdUrl: (id: string) => `/face.png?objectId=${id}`
            });
            return {
                source: result.source,
                objectId: result.objectId,
                image: result.image ? { w: result.image.naturalWidth, h: result.image.naturalHeight, src: result.image.src } : null,
                replyHasFrontId: (result.reply as any)?.data?.frontObjectId === frontObjectId,
                toClient: (window as any).__toClient__
            };
        }, { frontObjectId: FRONT_OBJECT_ID });

        expect(out.source).toBe('objectId');
        expect(out.objectId).toBe(FRONT_OBJECT_ID);
        // 取图走的是改写后的地址，尺寸与桩图一致（真机上为 540x960）。
        expect(out.image).toMatchObject({ w: 54, h: 96 });
        expect(out.image?.src).toContain('/face.png?objectId=' + FRONT_OBJECT_ID);
        expect(out.replyHasFrontId).toBe(true);

        // 先发 enable=1，收到画面后再发 enable=0，避免摄像头一直被占用。
        const enables = out.toClient
            .filter((entry: any) => entry.name === 'CLIENT_FACE_COLLECTION')
            .map((entry: any) => entry.payload.enable);
        expect(enables).toEqual(['1', '0']);
        await target.close();
    }, 30_000);

    test('客户端不回包时按超时返回 null，不抛异常', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            (window as any).jsBridge.device = 'android';
            // 桩客户端只回状态、不回画面：整段替换，避免原桩再回一张真图。
            (window as any).androidjsbridge.postNotification = function (name: string, payload: string) {
                if (name === 'CLIENT_FACE_COLLECTION' && JSON.parse(payload).enable === '1') {
                    setTimeout(() => (window as any).jsBridge.trigger(name, { recognizeStatus: 1, funconfig: '' }), 10);
                }
            };
            const started = Date.now();
            const result = await (window as any).__Lib__.requestFaceFrame({
                timeoutMs: 800,
                internalTimeMs: 1000,
                objectIdUrl: (id: string) => `/face.png?objectId=${id}`
            });
            return { source: result.source, image: result.image, elapsed: Date.now() - started };
        });

        expect(out.source).toBe('none');
        expect(out.image).toBeNull();
        expect(out.elapsed).toBeGreaterThanOrEqual(700);
        await target.close();
    }, 30_000);
});

describe('requestFaceFrame 的取图失败降级', () => {
    test('回复里有 objectId 但图取不回来时返回空画面而不是抛错', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            (window as any).jsBridge.device = 'android';
            const result = await (window as any).__Lib__.requestFaceFrame({
                timeoutMs: 5000,
                internalTimeMs: 1000,
                // 指到一个不存在的地址，强制取图失败。
                objectIdUrl: (id: string) => `/nope-${id}.png`
            });
            return { source: result.source, objectId: result.objectId, image: result.image };
        });

        expect(out.image).toBeNull();
        expect(out.source).toBe('none');
        // id 仍然保留，方便排查是地址模板不对还是图真没了。
        expect(out.objectId).toBe(FRONT_OBJECT_ID);
        await target.close();
    }, 30_000);
});

describe('键盘限制拦截', () => {
    test('CLIENT_LIMIT_KEYBOARD 不抵达客户端，并补一个 {result:1} 回包', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            (window as any).jsBridge.device = 'android';
            const replies: any[] = [];
            (window as any).jsBridge.bind('CLIENT_LIMIT_KEYBOARD', (payload: any) => replies.push(payload));
            (window as any).jsBridge.postNotification('CLIENT_LIMIT_KEYBOARD', { enable: 1 });
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
                replies,
                toClient: (window as any).__toClient__.map((entry: any) => entry.name)
            };
        });

        // 页面拿到了“健康值”，而客户端根本没收到这条协议（不会去改系统默认输入法）。
        expect(out.replies).toEqual([{ result: 1 }]);
        expect(out.toClient).not.toContain('CLIENT_LIMIT_KEYBOARD');
        await target.close();
    }, 30_000);
});

describe('上报替换管线', () => {
    test('把客户端回复里的 objectId 换成自己上传的 id 后重新分发', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            const seen: any[] = [];
            (window as any).jsBridge.bind('CLIENT_FACE_COLLECTION', (payload: any) => seen.push(payload));

            const events: any[] = [];
            const uninstall = lib.installMonitorFrameReplacement({
                compose: async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 1080;
                    canvas.height = 2400;
                    return canvas;
                },
                upload: async () => ({
                    ok: true,
                    objectId: 'ffffffffffffffffffffffffffffffff',
                    status: 200,
                    body: '{"data":{"objectId":"ffffffffffffffffffffffffffffffff"}}',
                    url: 'https://pan-yz.chaoxing.com/upload'
                }),
                onEvent: (event: any) => events.push(event)
            });

            // 模拟客户端触发一次带画面引用的回复。
            (window as any).jsBridge.trigger('CLIENT_FACE_COLLECTION', {
                data: {
                    frontObjectId: 'eb22bddf7ffee338164f3ca4e8df5702',
                    backObjectId: '06c639617c223448960c0a9d04cff465',
                    funconfig: '{}'
                },
                signToken: 'keepme',
                cxcid: 'keepme',
                cxtime: '1'
            });

            // 等异步替换完成。
            for (let i = 0; i < 50 && events.length === 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            uninstall();
            return { seen, events };
        });

        expect(out.events).toHaveLength(1);
        expect(out.events[0]).toMatchObject({ ok: true, objectId: 'ffffffffffffffffffffffffffffffff' });
        // 页面最后收到的是改写后的包：id 换成我们的，签名数据保持原样。
        expect(out.seen).toHaveLength(1);
        expect(out.seen[0].data.frontObjectId).toBe('ffffffffffffffffffffffffffffffff');
        expect(out.seen[0].data.backObjectId).toBe('ffffffffffffffffffffffffffffffff');
        // 换 id 后原签名必然失配，因此 signToken 被移除；cxcid/cxtime 等非签名字段保留。
        expect(out.seen[0].signToken).toBeUndefined();
        expect(out.seen[0].cxcid).toBe('keepme');
        await target.close();
    }, 30_000);

    test('上传失败时把原包原样放回，不让监控流程缺一条回复', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            const seen: any[] = [];
            (window as any).jsBridge.bind('CLIENT_SCREEN_MONITOR', (payload: any) => seen.push(payload));

            const events: any[] = [];
            const uninstall = lib.installMonitorFrameReplacement({
                compose: async () => document.createElement('canvas'),
                upload: async () => ({ ok: false, objectId: null, status: 200, body: 'puid 为空', url: 'x' }),
                onEvent: (event: any) => events.push(event)
            });
            (window as any).jsBridge.trigger('CLIENT_SCREEN_MONITOR', {
                data: { objectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
            });
            for (let i = 0; i < 50 && events.length === 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            uninstall();
            return { seen, events };
        });

        expect(out.events[0]).toMatchObject({ ok: false });
        expect(out.events[0].reason).toContain('puid 为空');
        // 原样放回：id 未被改动。
        expect(out.seen).toHaveLength(1);
        expect(out.seen[0].data.objectId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        await target.close();
    }, 30_000);

    test('回复用内联 base64 时也换成我们上传的画面', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            const seen: any[] = [];
            (window as any).jsBridge.bind('CLIENT_SNAPSHOT', (payload: any) => seen.push(payload));

            const events: any[] = [];
            const uninstall = lib.installMonitorFrameReplacement({
                compose: async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 540;
                    canvas.height = 960;
                    canvas.getContext('2d').fillRect(0, 0, 540, 960);
                    return canvas;
                },
                upload: async () => ({
                    ok: true,
                    objectId: 'e'.repeat(32),
                    status: 200,
                    body: '{}',
                    url: 'https://pan-yz.chaoxing.com/upload'
                }),
                onEvent: (event: any) => events.push(event)
            });

            (window as any).jsBridge.trigger('CLIENT_SNAPSHOT', {
                type: 3,
                captureStatus: 1,
                files: [{ name: 'shot.jpg', type: 'image/jpeg', data: 'A'.repeat(200) }]
            });

            for (let i = 0; i < 80 && events.length === 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            uninstall();
            return { seen, events };
        });

        expect(out.events[0]).toMatchObject({ ok: true });
        expect(out.seen).toHaveLength(1);
        // 真实画面被换成长串 base64，且结构化字段保留。
        expect(out.seen[0].files[0].data.length).toBeGreaterThan(200);
        expect(out.seen[0].files[0].data).not.toBe('A'.repeat(200));
        expect(out.seen[0].files[0].name).toBe('shot.jpg');
        expect(out.seen[0].type).toBe(3);
        await target.close();
    }, 30_000);

    test('重复安装只注册一次拦截器，事件不会重复', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            (window as any).jsBridge.device = 'android';
            let events = 0;
            let composes = 0;
            const upload = async () => ({
                ok: true,
                objectId: 'a'.repeat(32),
                status: 200,
                body: '{}',
                url: 'x'
            });
            lib.installMonitorFrameReplacement({
                compose: async () => {
                    composes++;
                    return document.createElement('canvas');
                },
                upload,
                onEvent: () => events++
            });
            lib.installMonitorFrameReplacement({ upload, onEvent: () => events++ });

            (window as any).jsBridge.trigger('CLIENT_SCREEN_MONITOR', {
                data: { objectId: 'b'.repeat(32) }
            });
            for (let i = 0; i < 60 && events < 2; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            lib.uninstallMonitorFrameReplacement();
            return { events, composes, installed: lib.isMonitorReplacementInstalled() };
        });

        // 两个订阅者各收到一次事件（订阅可以重复，拦截器不会重复）。
        expect(out.events).toBe(2);
        expect(out.composes).toBe(1);
        expect(out.installed).toBe(false);
        await target.close();
    }, 30_000);

    test('人脸回复里的真实画面被复用为悬浮窗内容', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            (window as any).jsBridge.device = 'android';
            let composedWith: any = null;
            const events: any[] = [];
            lib.installMonitorFrameReplacement({
                // 把人脸地址指到本地桩图，验证“从回复的 objectId 取真实画面”这条链路。
                objectIdUrl: (id: string) => `/face.png?objectId=${id}`,
                compose: async (face: HTMLImageElement | null) => {
                    composedWith = face ? { w: face.naturalWidth, h: face.naturalHeight } : null;
                    const canvas = document.createElement('canvas');
                    canvas.width = 540;
                    canvas.height = 960;
                    return canvas;
                },
                upload: async () => ({ ok: true, objectId: 'c'.repeat(32), status: 200, body: '{}', url: 'x' }),
                onEvent: (event: any) => events.push(event)
            });

            (window as any).jsBridge.trigger('CLIENT_FACE_COLLECTION', {
                data: { frontObjectId: 'eb22bddf7ffee338164f3ca4e8df5702', backObjectId: 'd'.repeat(32) }
            });
            for (let i = 0; i < 60 && events.length === 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            lib.uninstallMonitorFrameReplacement();
            return { composedWith, events };
        });

        expect(out.composedWith).toEqual({ w: 54, h: 96 });
        expect(out.events[0]).toMatchObject({ ok: true });
        await target.close();
    }, 30_000);

    test('纯状态回复不进替换流程', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const lib = (window as any).__Lib__;
            const seen: any[] = [];
            (window as any).jsBridge.bind('CLIENT_SCREEN_MONITOR', (payload: any) => seen.push(payload));
            const events: any[] = [];
            const uninstall = lib.installMonitorFrameReplacement({
                compose: async () => {
                    throw new Error('不该被调用');
                },
                upload: async () => {
                    throw new Error('不该被调用');
                },
                onEvent: (event: any) => events.push(event)
            });
            (window as any).jsBridge.trigger('CLIENT_SCREEN_MONITOR', { status: 1, funconfig: '' });
            await new Promise((resolve) => setTimeout(resolve, 300));
            uninstall();
            return { seen, events };
        });

        expect(out.events).toHaveLength(0);
        expect(out.seen).toEqual([{ status: 1, funconfig: '' }]);
        await target.close();
    }, 30_000);
});

describe('探针的合成钩子', () => {
    test('提供 compose 时面板出现合成按钮并能出图', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        // 人脸采集步骤带风险，会先弹确认；测试按“同意”处理。
        await target.addInitScript(() => {
            (window as any).confirm = () => true;
        });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            (window as any).jsBridge.device = 'android';
            const probe = (window as any).__Lib__.installFaceProbe({
                autoRun: false,
                waitScale: 0.05,
                includeScreenMonitor: false,
                objectIdUrl: (id: string) => `/face.png?objectId=${id}`,
                // 桩合成器：真实实现会调 fake-screen，这里只验证探针把画面交了出去。
                compose: async (face: any) => {
                    (window as any).__composeArg__ = face ? { w: face.naturalWidth, h: face.naturalHeight } : null;
                    const canvas = document.createElement('canvas');
                    canvas.width = 1080;
                    canvas.height = 2400;
                    return canvas;
                }
            });

            const beforeRun = probe.canCompose();
            await probe.run({ waitScale: 0.05, includeScreenMonitor: false });
            const shadow = document.getElementById('sw4c-face-probe-panel')!.shadowRoot!;
            const sectionVisible = !(shadow.getElementById('composeSection') as HTMLElement).hidden;
            const outcome = await probe.composeFrame();
            return {
                beforeRun,
                sectionVisible,
                outcome,
                composeArg: (window as any).__composeArg__,
                previews: shadow.getElementById('composeOut')!.querySelectorAll('img').length,
                reportCompose: (probe.report() as any).compose
            };
        });

        expect(out.beforeRun).toBe(true);
        expect(out.sectionVisible).toBe(true);
        expect(out.outcome).toMatchObject({ ok: true, width: 1080, height: 2400 });
        expect(out.outcome.bytes).toBeGreaterThan(1000);
        // 探针把真机取到的那张脸交给了合成器。
        expect(out.composeArg).toEqual({ w: 54, h: 96 });
        expect(out.previews).toBe(1);
        expect(out.reportCompose?.ok).toBe(true);
        await target.close();
    }, 30_000);

    test('没有 compose 时不显示合成按钮', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Lib__ !== undefined);

        const out = await target.evaluate(async () => {
            const probe = (window as any).__Lib__.installFaceProbe({ autoRun: false, includeScreenMonitor: false });
            for (let i = 0; i < 50 && !document.getElementById('sw4c-face-probe-panel'); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const shadow = document.getElementById('sw4c-face-probe-panel')!.shadowRoot!;
            const outcome = await probe.composeFrame();
            return {
                canCompose: probe.canCompose(),
                hidden: (shadow.getElementById('composeSection') as HTMLElement).hidden,
                outcomeOk: outcome.ok,
                error: outcome.error
            };
        });

        expect(out.canCompose).toBe(false);
        expect(out.hidden).toBe(true);
        expect(out.outcomeOk).toBe(false);
        expect(out.error).toContain('未提供');
        await target.close();
    }, 30_000);
});

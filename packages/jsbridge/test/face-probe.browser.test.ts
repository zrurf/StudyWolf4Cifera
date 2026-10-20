/**
 * 人脸探针的浏览器测试。
 *
 * 用桩 bridge 模拟客户端：记录页面发出的协议，并按需回包。这样能在不接触真机的前提下验证
 * 探针的发送顺序、回复收集、取图、提前结束，以及独立入口的自动运行。
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

/** 单色 PNG，避免依赖磁盘上的二进制素材。 */
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

const FACE_PNG = solidPng(64, 80, [0x22, 0x99, 0x44]);
/** 32 位十六进制，形如超星云盘的 objectId。 */
const FAKE_OBJECT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** 桩 bridge：记录发出去的协议，并按 `window.__replyScript__` 回包。 */
const STUB_BRIDGE = `
window.__sent__ = [];
window.__replyScript__ = {};
window.__listeners__ = {};
window.jsBridge = {
  device: 'ios',
  isReady: false,
  postNotification: function (name, payload) {
    window.__sent__.push({ name: name, payload: payload });
    var reply = window.__replyScript__[name];
    if (reply) {
      var listeners = window.__listeners__[name] || [];
      setTimeout(function () {
        for (var i = 0; i < listeners.length; i++) listeners[i](reply);
      }, 5);
    }
  },
  trigger: function (name, payload) {
    var listeners = window.__listeners__[name] || [];
    for (var i = 0; i < listeners.length; i++) listeners[i](payload);
  },
  bind: function (name, cb) { (window.__listeners__[name] = window.__listeners__[name] || []).push(cb); },
  unbind: function (name, cb) {
    var list = window.__listeners__[name] || [];
    var index = list.indexOf(cb);
    if (index !== -1) list.splice(index, 1);
  },
  setDevice: function (device) { this.device = device; this.isReady = true; }
};
window.androidjsbridge = { postNotification: function () {}, getTitle: function () { return 'stub'; } };
`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** 库入口：测试自己决定何时、以什么参数运行。 */
let librarySource = '';
/** 独立入口：注入即自动运行。 */
let standaloneSource = '';
/** bridge + 探针入口：注入即自动运行，且自己接管 window.jsBridge。 */
let withBridgeSource = '';

const ORIGIN = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
    const [library, standalone, withBridge] = await Promise.all([
        Bun.build({
            entrypoints: [join(import.meta.dir, '..', 'src', 'probe', 'face-probe.ts')],
            target: 'browser',
            format: 'esm',
            minify: false
        }),
        Bun.build({
            entrypoints: [join(import.meta.dir, '..', 'src', 'probe', 'standalone.ts')],
            target: 'browser',
            format: 'esm',
            minify: false
        }),
        Bun.build({
            entrypoints: [join(import.meta.dir, '..', 'src', 'probe', 'with-bridge.ts')],
            target: 'browser',
            format: 'esm',
            minify: false
        })
    ]);
    if (!library.success || !standalone.success || !withBridge.success) throw new Error('probe bundle failed');
    librarySource = await library.outputs[0].text();
    standaloneSource = await standalone.outputs[0].text();
    withBridgeSource = await withBridge.outputs[0].text();

    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/probe-lib.js') {
                return new Response(librarySource, { headers: { 'content-type': 'application/javascript' } });
            }
            if (url.pathname === '/probe-standalone.js') {
                return new Response(standaloneSource, { headers: { 'content-type': 'application/javascript' } });
            }
            if (url.pathname === '/probe-with-bridge.js') {
                return new Response(withBridgeSource, { headers: { 'content-type': 'application/javascript' } });
            }
            if (url.pathname === '/face.png') {
                return new Response(FACE_PNG, { headers: { 'content-type': 'image/png' } });
            }

            const page = url.searchParams.get('withBridge')
                ? `<script>window.__native__ = []; window.androidjsbridge = { postNotification: function (n, p) { window.__native__.push({ n: n, p: p }); } };</script>
                   <script type="module" src="/probe-with-bridge.js"></script>`
                : url.searchParams.get('standalone')
                  ? `<script type="module" src="/probe-standalone.js"></script>`
                  : `<script type="module">
                       import * as Probe from '/probe-lib.js';
                       window.__Probe__ = Probe;
                     </script>`;
            const examMarkers = url.searchParams.get('exam')
                ? '<input type="hidden" id="testUserRelationId" value="167239306">'
                : '';
            return new Response(
                `<!doctype html><html><head><meta charset="utf-8">
                 <script>${STUB_BRIDGE}</script>${page}</head>
                 <body><h1>探针测试页</h1>${examMarkers}</body></html>`,
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

/** 打开页面并主动运行探针（等待时间压到 5%，测试才跑得动）。 */
async function runProbe(
    replyScript: Record<string, unknown> = {},
    includeScreenMonitor = true
): Promise<{ report: any; sent: { name: string; payload: any }[]; panel: () => Promise<any> }> {
    const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
    // 有副作用的步骤会先弹确认，测试里按“用户同意”处理。
    await target.addInitScript(() => {
        (window as any).confirm = () => true;
    });
    await target.goto(`${ORIGIN()}/`);
    await target.waitForFunction(() => (window as any).__Probe__ !== undefined);

    const result = await target.evaluate(
        async ({ replyScript, includeScreenMonitor }) => {
            (window as any).__replyScript__ = replyScript;
            const probe = (window as any).__Probe__.installFaceProbe({
                autoRun: false,
                waitScale: 0.05,
                includeScreenMonitor,
                objectIdUrl: (id: string) => `/face.png?objectId=${id}`
            });
            const report = await probe.run();
            return { report, sent: (window as any).__sent__ };
        },
        { replyScript, includeScreenMonitor }
    );

    const panel = async () => {
        const snapshot = await target.evaluate(() => {
            const host = document.getElementById('sw4c-face-probe-panel');
            const shadow = host?.shadowRoot;
            return {
                exists: !!host,
                status: shadow?.getElementById('status')?.textContent ?? '',
                stepsHtml: shadow?.getElementById('steps')?.innerHTML ?? '',
                imageCount: shadow?.querySelectorAll('img').length ?? 0
            };
        });
        await target.close();
        return snapshot;
    };

    return { ...result, panel };
}

describe('人脸探针', () => {
    test('独立入口注入后自动发送第一个采集请求', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.addInitScript(() => {
            (window as any).confirm = () => true;
        });
        await target.goto(`${ORIGIN()}/?standalone=1`);
        await target.waitForFunction(() => (window as any).__SW4C_FACE_PROBE__ !== undefined);
        await target.waitForFunction(() => ((window as any).__sent__ || []).length > 0, null, { timeout: 10_000 });

        const first = await target.evaluate(() => ({
            sent: (window as any).__sent__[0],
            device: (window as any).jsBridge.device
        }));
        expect(first.sent.name).toBe('CLIENT_FACE_COLLECTION');
        expect(first.sent.payload.enable).toBe(1);
        expect(first.sent.payload.enableCapture).toBe(1);
        // 桩 bridge 是 ios 且存在 androidjsbridge，探针应改为 android 走注入对象通道。
        expect(first.device).toBe('android');
        await target.close();
    }, 30_000);

    test('客户端回 objectId 时取到画面并提前结束', async () => {
        const { report, sent } = await runProbe({
            CLIENT_FACE_COLLECTION: {
                recognizeStatus: 1,
                data: { captureStatus: 1, captureObjectId: FAKE_OBJECT_ID, picCollectTime: 1 }
            }
        });

        expect(report.environment.bridge).toBe('client');
        expect(report.environment.hasAndroidBridge).toBe(true);
        expect(report.environment.androidBridgeKeys).toEqual(['postNotification', 'getTitle']);
        expect(report.steps).toHaveLength(1);
        expect(report.steps[0].replies).toHaveLength(1);
        expect(report.steps[0].image).toMatchObject({ source: 'objectId', width: 64, height: 80 });
        expect(report.notes.join()).toContain('已拿到画面');
        expect(sent).toHaveLength(1);
    }, 30_000);

    test('客户端不回包时逐步跑完并如实记录无回复', async () => {
        const { report, sent } = await runProbe({});

        expect(report.steps).toHaveLength(5);
        expect(report.steps.every((step: any) => step.replies.length === 0)).toBe(true);
        expect(sent.map((entry) => entry.name)).toEqual([
            'CLIENT_FACE_COLLECTION',
            'CLIENT_FACE_COLLECTION',
            'CLIENT_FACE_RECOGNITION_BLINK',
            'CLIENT_SNAPSHOT',
            'CLIENT_SCREEN_MONITOR'
        ]);
        expect(report.finishedAt).toBeTruthy();
    }, 60_000);

    test('关掉录屏步骤时只跑四步', async () => {
        const { sent } = await runProbe({}, false);
        expect(sent.map((entry) => entry.name)).toEqual([
            'CLIENT_FACE_COLLECTION',
            'CLIENT_FACE_COLLECTION',
            'CLIENT_FACE_RECOGNITION_BLINK',
            'CLIENT_SNAPSHOT'
        ]);
    }, 60_000);

    test('面板展示结果、能取图，报告落库 localStorage', async () => {
        const { panel } = await runProbe({
            CLIENT_FACE_COLLECTION: { data: { captureObjectId: FAKE_OBJECT_ID } }
        });
        const snapshot = await panel();

        expect(snapshot.exists).toBe(true);
        expect(snapshot.status).toContain('完成');
        expect(snapshot.stepsHtml).toContain('画面');
        expect(snapshot.imageCount).toBeGreaterThan(0);
    }, 30_000);

    test('注入即生效入口：无需任何开关就自动运行，且只建一个面板', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.addInitScript(() => {
            (window as any).confirm = () => true;
        });
        await target.goto(`${ORIGIN()}/?withBridge=1`);
        await target.waitForFunction(() => (window as any).__SW4C_FACE_PROBE__ !== undefined);
        await target.waitForFunction(() => ((window as any).__native__ || []).length > 0, null, { timeout: 10_000 });

        const state = await target.evaluate(() => ({
            panels: document.querySelectorAll('#sw4c-face-probe-panel').length,
            hasStudyWolf: !!window.__STUDY_WOLF__,
            first: window.__native__[0],
            textareaHasReport: (document.getElementById('sw4c-face-probe-panel')?.shadowRoot
                ?.getElementById('json') as HTMLTextAreaElement | null)?.value?.length ?? 0
        }));

        expect(state.panels).toBe(1);
        expect(state.hasStudyWolf).toBe(true);
        expect(state.first.n).toBe('CLIENT_FACE_COLLECTION');
        expect(JSON.parse(state.first.p).enable).toBe(1);
        expect(state.textareaHasReport).toBeGreaterThan(200);
        await target.close();
    }, 30_000);

    test('非考试页拒绝确认时跳过有副作用的步骤', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.addInitScript(() => {
            (window as any).confirm = () => false;
        });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Probe__ !== undefined);

        const out = await target.evaluate(async () => {
            const probe = (window as any).__Probe__.installFaceProbe({
                autoRun: false,
                waitScale: 0.02,
                includeScreenMonitor: false
            });
            const report = await probe.run({ waitScale: 0.02, includeScreenMonitor: false });
            return { steps: report.steps, sent: (window as any).__sent__ };
        });

        // 带风险的三个步骤被跳过（人脸采集两条 + 活体采集），不带风险的抓拍照常发送。
        expect(out.steps.slice(0, 3).every((step: any) => !!step.skipped)).toBe(true);
        expect(out.steps[0].skipped).toContain('用户取消');
        expect(out.steps[3].skipped).toBeUndefined();
        // 关键：CLIENT_FACE_COLLECTION / FACE_RECOGNITION_BLINK 一条都没发给客户端。
        expect(out.sent.map((entry: any) => entry.name)).toEqual(['CLIENT_SNAPSHOT']);
        await target.close();
    }, 30_000);

    test('考试页不弹确认，直接发送', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.addInitScript(() => {
            (window as any).__confirmCalls__ = 0;
            (window as any).confirm = () => {
                (window as any).__confirmCalls__++;
                return false;
            };
        });
        await target.goto(`${ORIGIN()}/?exam=1`);
        await target.waitForFunction(() => (window as any).__Probe__ !== undefined);

        const out = await target.evaluate(async () => {
            const probe = (window as any).__Probe__.installFaceProbe({
                autoRun: false,
                waitScale: 0.02,
                includeScreenMonitor: false
            });
            const report = await probe.run({ waitScale: 0.02, includeScreenMonitor: false });
            return {
                confirmCalls: (window as any).__confirmCalls__,
                sent: (window as any).__sent__.map((entry: any) => entry.name),
                firstSkipped: report.steps[0]?.skipped ?? null
            };
        });

        // 页面里有考试标记 -> 不确认，且第一步照发。
        expect(out.confirmCalls).toBe(0);
        expect(out.firstSkipped).toBeNull();
        expect(out.sent[0]).toBe('CLIENT_FACE_COLLECTION');
        await target.close();
    }, 30_000);

    test('重复安装探针不产生第二个面板', async () => {
        const target = await browser.newPage({ viewport: { width: 360, height: 679 } });
        await target.goto(`${ORIGIN()}/`);
        await target.waitForFunction(() => (window as any).__Probe__ !== undefined);
        const outcome = await target.evaluate(async () => {
            const probe = (window as any).__Probe__;
            const first = probe.installFaceProbe({ autoRun: false, panel: true });
            const second = probe.installFaceProbe({ autoRun: false, panel: true });
            // 面板是在 bridge 就绪后异步创建的，这里等它出现再数。
            for (let i = 0; i < 50 && !document.getElementById('sw4c-face-probe-panel'); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return {
                sameInstance: first === second,
                globalIsFirst: (window as any).__SW4C_FACE_PROBE__ === first,
                panels: document.querySelectorAll('#sw4c-face-probe-panel').length
            };
        });
        expect(outcome.sameInstance).toBe(true);
        expect(outcome.globalIsFirst).toBe(true);
        expect(outcome.panels).toBe(1);
        await target.close();
    }, 30_000);
});

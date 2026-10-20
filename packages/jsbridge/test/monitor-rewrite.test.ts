/**
 * 上报改写的纯函数测试：替换规则与账号 id 解析都不该只能在浏览器里跑。
 */
import { describe, expect, test } from 'bun:test';

import {
    findPuidInReply,
    hasInlineImageFiles,
    rewriteInlineImages,
    rewriteObjectIds
} from '../src/monitor/rewrite.js';
import { harvestUploadContext, resolvePuid } from '../src/monitor/upload.js';

/** 真机回包的形状（docs/chaoxing.txt）。 */
const REAL_REPLY = {
    data: {
        picCollectTime: 1790256242813,
        frontStatus: 1,
        frontObjectId: 'eb22bddf7ffee338164f3ca4e8df5702',
        backStatus: 1,
        backObjectId: '06c639617c223448960c0a9d04cff465',
        funconfig: '{}'
    },
    captureMode: 0,
    signToken: 'a38b3dcbbb19f4bd926ec4e10429ca09',
    cxcid: '3e57ec8c74669bf1ad3d28be5badd309410191884',
    cxtime: '1790256248390'
};

describe('rewriteObjectIds', () => {
    test('把人脸回复里的前后置 id 都换成自己的', () => {
        const payload = structuredClone(REAL_REPLY) as Record<string, unknown>;
        const replaced = rewriteObjectIds(payload, 'ffffffffffffffffffffffffffffffff');

        expect(replaced).toBe(2);
        const data = payload.data as Record<string, string>;
        expect(data.frontObjectId).toBe('ffffffffffffffffffffffffffffffff');
        expect(data.backObjectId).toBe('ffffffffffffffffffffffffffffffff');
        // 其他字段（尤其是签名）不该被动。
        expect((payload as Record<string, string>).signToken).toBe(REAL_REPLY.signToken);
        expect((payload as Record<string, string>).cxcid).toBe(REAL_REPLY.cxcid);
    });

    test('录屏回复里的 captureObjectId/objectId 同样能换', () => {
        const payload = {
            controlType: 0,
            data: { objectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', completeTime: 1 },
            captureObjectId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        };
        expect(rewriteObjectIds(payload, 'cccccccccccccccccccccccccccccccc')).toBe(2);
        expect(payload.data.objectId).toBe('cccccccccccccccccccccccccccccccc');
    });

    test('没有画面引用时返回 0', () => {
        expect(rewriteObjectIds({ recognizeStatus: 1, funconfig: '' }, 'd'.repeat(32))).toBe(0);
        expect(rewriteObjectIds(null, 'd'.repeat(32))).toBe(0);
    });
});

describe('findPuidInReply', () => {
    test('优先取浅层的 puid 字段', () => {
        expect(findPuidInReply({ puid: '410191884', data: { userId: 999 } })).toEqual({
            value: '410191884',
            field: 'puid'
        });
    });

    test('没有 puid 时退到 userId / personId', () => {
        expect(findPuidInReply({ data: { userId: '410191884' } })).toEqual({
            value: '410191884',
            field: 'userId'
        });
        expect(findPuidInReply({ info: { personId: 410191884 } })).toEqual({
            value: '410191884',
            field: 'personId'
        });
    });

    test('短数字与 uuid 不算账号 id', () => {
        expect(findPuidInReply({ uuid: 'db0126b6c7434a008c36321e220de522' }).value).toBeNull();
        expect(findPuidInReply({ id: 42 }).value).toBeNull();
        expect(findPuidInReply('done').value).toBeNull();
    });
});

describe('resolvePuid', () => {
    test('页面里找不到就返回空，并给出尝试记录（交由客户端回答）', () => {
        const resolved = resolvePuid({});
        expect(resolved.value).toBeNull();
        expect(resolved.source).toBeNull();
        // 尝试过隐藏输入与地址参数；cxcid 尾部不可靠，已刻意不做猜测。
        expect(resolved.tried).toContain('input:userId');
        expect(resolved.tried).not.toContain('cxcid');
    });
});

describe('harvestUploadContext', () => {
    test('CLIENT_SCREEN_MONITOR：上传参数与 uploadConfig 在顶层', () => {
        const harvested = harvestUploadContext([
            {
                enable: 1,
                uploadParams: { uploadtype: 'examkeeper', fid: 'abc' },
                uploadConfig: JSON.stringify({ uploadUrl: 'https://exam.example.com/upload?sign=1' })
            }
        ]);

        expect(harvested.params).toEqual({ uploadtype: 'examkeeper', fid: 'abc' });
        expect(harvested.uploadUrl).toBe('https://exam.example.com/upload?sign=1');
    });

    test('CLIENT_FACE_COLLECTION：7.0.4 把上传参数放进 data', () => {
        const harvested = harvestUploadContext([
            {
                enable: '1',
                data: {
                    internalTime: 10000,
                    uploadParams: '{"uploadtype":"face_temp"}',
                    faceUploadParam: { uploadtype: 'face_temp' },
                    uploadConfig: '{"isYunPan":1,"fid":"fid123","isMirror":0}'
                }
            }
        ]);

        expect(harvested.params).toEqual({ uploadtype: 'face_temp' });
        expect(harvested).toMatchObject({ isYunPan: true, fid: 'fid123', isMirror: 0 });
    });

    test('后出现的参数覆盖先出现的；空载荷被忽略', () => {
        const harvested = harvestUploadContext([
            null,
            { uploadParams: { uploadtype: 'old' } },
            { data: { uploadParams: { uploadtype: 'new' } } }
        ]);
        expect(harvested.params.uploadtype).toBe('new');
    });
});

describe('内联 base64 画面', () => {
    const inlineReply = () => ({
        type: 3,
        captureStatus: 1,
        files: [
            { name: 'a.jpg', type: 'image/jpeg', data: 'A'.repeat(120) },
            { name: 'b.jpg', type: 'image/jpeg', data: 'B'.repeat(120) }
        ]
    });

    test('识别出 files[].data 里的 base64', () => {
        expect(hasInlineImageFiles(inlineReply())).toBe(true);
        expect(hasInlineImageFiles({ data: { objectId: 'a'.repeat(32) } })).toBe(false);
        expect(hasInlineImageFiles({ files: 'file:///tmp/a.jpg' })).toBe(false);
    });

    test('替换成自己的画面并保留其它字段', () => {
        const payload = inlineReply();
        expect(rewriteInlineImages(payload, 'MYIMAGE')).toBe(2);
        expect(payload.files[0].data).toBe('MYIMAGE');
        expect(payload.files[1].data).toBe('MYIMAGE');
        expect(payload.files[0].name).toBe('a.jpg');
        expect(payload.type).toBe(3);
    });
});

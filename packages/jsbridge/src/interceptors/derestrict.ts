import type { InterceptorHandler } from '@study-wolf-cifera/shared-types';

import { jsBridge } from '../bridge.js';
import { jsBridgeEnv } from '../utils/env.js';

/**
 * 监考协议的拦截策略。
 *
 * 客户端通过这条 bridge 下发生命周期与锁定类通知，其他协议则用 `jsBridge.trigger` 回复。这里
 * 全部是**被动**处理：挡住页面不该知道的事件、记下页面不该丢的信息，但绝不冒充客户端，也不
 * 凭空造回复。需要伪造画面时另有按需路径（见 `monitor/frame.ts`）。
 */

/**
 * 切屏上报（`CLIENT_WEB_LIFECYCLE`）。
 *
 * 客户端上报 `10`（退到后台）/`11`（回到前台）/`20`（悬浮窗），页面据此写切屏日志、发起悬浮窗
 * 抓拍，并在超过配置次数后强制交卷。只放行 `1`（页面可见），既让页面自身的时间记账保持一致，
 * 又不会留下任何离开记录。
 *
 * 回复走 `trigger`，字段名为 `userInfo`；同名协议也用于请求，那时字段名是 `payload`，因此两者
 * 都要看。
 */
export const interceptorSwitch: InterceptorHandler<any> = (ctx, next) => {
    const args = ctx.args as { name?: string; userInfo?: { status?: number }; payload?: { status?: number } };
    if (args?.name === 'CLIENT_WEB_LIFECYCLE') {
        const status = args.userInfo?.status ?? args.payload?.status;
        if (status !== 1) ctx.cancel = true;
    }
    next();
};

/**
 * 第三方输入法限制（`CLIENT_LIMIT_KEYBOARD`）。
 *
 * `enable: 1` 会让客户端改写系统默认输入法（7.0.4 里是 `Settings.Secure.default_input_method`），考试页
 * 的正常输入与粘贴就是被它挡住的，因此在抵达客户端前丢弃；关闭请求一并丢弃也无副作用——限制本来就没
 * 生效过。
 *
 * 客户端处理完会用 `{result:N}` 回包（7.0.4 还会在输入法变化时持续回包）。拦下之后页面若在等这个结果，
 * 会一直等不到，因此这里补一个 `{result:1}`（“App 输入法已启用且为默认”这一健康值），让页面按“已限制”
 * 继续走，而实际键盘仍是用户自己的。
 */
export const interceptorKeyboard: InterceptorHandler<any> = (ctx, next) => {
    const args = ctx.args as { name?: string };
    if (args?.name === 'CLIENT_LIMIT_KEYBOARD') {
        ctx.cancel = true;
        // 异步回，贴近 native 的回包时序；页面已卸载时 trigger 自己会兜住异常。
        setTimeout(() => {
            try {
                jsBridge.trigger('CLIENT_LIMIT_KEYBOARD', { result: 1 });
            } catch {
                // 页面已卸载，忽略。
            }
        }, 0);
    }
    next();
};

/**
 * 工具栏标题与自定义返回键捕获。
 *
 * `CLIENT_TOOLBAR_TITLE` 带考试标题（考生姓名与学号），`CLIENT_CUSTOM_LEFTBTN` 带返回键图标。
 * 两者都记进环境对象，供伪造帧的标题栏使用，然后原样转发。
 */
export const interceptorTitle: InterceptorHandler<any> = (ctx, next) => {
    const args = ctx.args as { name?: string; payload?: Record<string, any> };
    if (args?.name === 'CLIENT_TOOLBAR_TITLE' && typeof args.payload?.webTitle === 'string') {
        jsBridgeEnv().title = args.payload.webTitle;
    } else if (args?.name === 'CLIENT_CUSTOM_LEFTBTN') {
        jsBridgeEnv().left_btn = args.payload ?? null;
    }
    next();
};

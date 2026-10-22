# StudyWolf for Cifera

[**StudyWolf**](https://github.com/zrurf/StudyWolf) 项目的**Cifera**版本。一个基于Cifera的**学x通**插件。

**做题体验该优化了**

## 什么是 for Cifera？

原版以[**Punklorde**](https://github.com/zrurf/Punklorde)为运行基座，该版本以[**Cifera**](https://github.com/zrurf/cifera)为运行基座。即该版本运行在Cifera正向代理中，通过直接向目标页面注入JS代码来实现功能。

## 介绍
该版本以**Cifera Addon**形式分发，直接把`addon.toml`和编译产物放到Cifera的`addons`目录下，并配置好`config.toml`文件即可。

~~我Minecraft都能打mod，为什么学x通不行？~~

### Punklorde 附属项目
该项目为 [Punklorde](https://github.com/zrurf/Punklorde) 的附属项目，与Punklorde共用相同许可证授权，受到相同约束。

## 使用说明
### 编译
#### 1. 安装环境
- Bun 1.3.10 版本以上 *(不可换为Node.js)*

#### 2. 编译
在项目根目录下执行
```bash
bun i           # 安装依赖

bun run build   # 构建
```

### 3. 配置
把`addon.toml`和`dist`目录，放到Cifera的`addons/sw4c`目录下。目录结构如下：
```
/
├── cifera.exe
├── addons/
    ├── sw4c/
        ├── addon.toml/
        ├── dist/
```

## 功能
- [x] 允许多端登录
- [x] 防切屏检测
- [x] 解除键盘禁用
- [x] 截屏/抓拍/人脸三类监控回复的画面替换：合成伪造帧、自行上传、改写回调里的图片引用
- [x] 摄像头画面不伪造：悬浮窗取客户端真实采集（人脸回复里的真实画面会复用为窗口内容）
- [x] 真机诊断探针（`dist/jsbridge-probe.js`，注入即运行；正式产物 `dist/jsbridge.js` 默认**不安装探针**，
      需要时设 `localStorage['sw4c-face-probe']='1'` 刷新，或控制台 `__STUDY_WOLF__.installFaceProbe({panel:true})`）

替换只改页面收到的图片引用，**不阻止客户端自己上传原始截图**（那条链路在 native 侧，JS 无法拦截），
也不是连续视频流替换。任何一步失败都会把客户端原始回复原样放回；需要临时关闭时设
`localStorage['sw4c-monitor-hijack'] = '0'`。

## 许可证
[Non-Commercial Academic License](LICENSE)
import * as Bun from "bun";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 把 bridge 打成单个 IIFE，供 `addon.toml` 顶替 `CXJSBridge.js` 下发。
 *
 * 依赖（构图模块与 SnapDOM）一并打进产物，因此输出必须是自包含的压缩文件。
 * 另外两个产物与探针有关：
 * - `jsbridge-probe.js`：bridge + 探针**注入即运行**，用于真机验证（把 addon.toml 的规则指向它）。
 * - `face-probe.js`：只有探针，不接管 bridge，可单独注入。
 */
async function build(entry: string, outputName: string): Promise<void> {
    const outdir = resolve(import.meta.dir, "../../dist");
    await mkdir(outdir, { recursive: true });
    const result = await Bun.build({
        entrypoints: [resolve(import.meta.dir, entry)],
        outdir,
        naming: outputName,
        target: "browser",
        format: "iife",
        minify: true,
        sourcemap: "none"
    });

    if (!result.success) {
        console.error(`Build failed for ${entry}:`);
        for (const log of result.logs) {
            console.error(`  ${log.message}`);
        }
        process.exit(1);
    }

    console.log(`Build succeeded: ${entry}`);
    for (const output of result.outputs) {
        console.log(`  ${output.path} (${output.size} bytes)`);
    }
}

await build("./src/index.ts", "jsbridge.js");
await build("./src/probe/with-bridge.ts", "jsbridge-probe.js");
await build("./src/probe/standalone.ts", "face-probe.js");

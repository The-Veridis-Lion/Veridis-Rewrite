# 回归验证

测试只使用中性示例、模拟接口和隔离数据，不需要真实模型密钥，也不调用收费模型。
浏览器及 YAML 包只作为开发依赖；扩展运行时继续使用宿主已有能力。

```sh
npm install
npx playwright install chromium
npm test
npm run test:ui
```

`npm test` 运行不依赖外部插件源码的单元测试。下面两项集成测试需要显式指定只读源码：

```sh
RULE_ROUTER_SOURCE=/path/to/cultivation-rule-router/index.js \
VERIDIS_SSE_SOURCE=/path/to/SillyTavern/public/scripts/sse-stream.js \
npm run test:integration
```

路由测试在 VM 中运行真实规则路由的生成回调；流式测试使用宿主 `EventSourceStream`，覆盖 UTF-8 分片、结束标记、普通 JSON 回退、错误与取消。源码 fixture 应固定版本，避免把第三方更新与本次改动混在一起。

千千结 DOM/事件契约测试需要固定版本的 `inline-renderer.js`、`backend-client.js`，放在同一个目录中：

```sh
BLAI_MYRIAD_REFERENCE=/path/to/pinned-myriad-source \
BLAI_COMPAT_OUTPUT=test-results/myriad.json \
npm run test:myriad
```

它运行原渲染器与存储客户端，宿主及存储数据响应受控；它不是 Android APK 或真实后台服务测试。

完整入口 A/B 测试需要原版检出目录、当前检出目录及固定的 Luker CSS/jQuery：

```sh
BLAI_AB_BASE=/path/to/workspace \
BLAI_AB_ORIGINAL=Veridis-Rewrite-original-46182c6 \
BLAI_AB_CANDIDATE=/path/to/current-checkout \
BLAI_AB_REFERENCE=/path/to/folder-with-jquery.js-and-luker-style.css \
npm run test:startup
```

该测试对照原版和当前完整入口，模拟打开 700 楼聊天与 DOM 变化，使用 6 倍 CPU 限速检查布局读取、观察器与非预期保存。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `BLAI_TEST_CHROME` | 使用已有 Chrome/Chromium 可执行文件；未设置则使用 Playwright 安装的 Chromium |
| `BLAI_TEST_MODULES` | 外部已安装 Playwright 的 `node_modules/` 路径 |
| `VERIDIS_YAML_MODULE` | 宿主已安装的 `yaml` 包路径；未设置则使用开发依赖 |
| `BLAI_TEST_OUTPUT` | 界面检查的输出目录 |

示例使用 POSIX 环境变量写法；PowerShell 中使用 `$env:变量名='值'` 后运行相同的 npm 命令。
真实 Luker 联合测试的结果和边界另见 [验证记录](../docs/compatibility-verification.md)。


## 修复22补充

`npm test` 包含本地时间显示、边界回抄、一次受限纠正、取消和过期写回检查。测试正文为合成示例。

TauriTavern 路由契约测试另行运行 `npm run test:tauri`。设置 `VERIDIS_TAURI_REFERENCE` 为外部 fixture 目录，并从固定提交 `fff9af0333be97697be2313981699ab0ce35c236` 下载以下文件，分别保存为：

- `tauri240-ai-routes.js`：[ai-routes.js](https://github.com/Darkatse/TauriTavern/blob/fff9af0333be97697be2313981699ab0ce35c236/src/tauri/main/routes/ai-routes.js)
- `tauri240-generation-lifecycle.js`：[generation-lifecycle-service.js](https://github.com/Darkatse/TauriTavern/blob/fff9af0333be97697be2313981699ab0ce35c236/src/tauri/main/services/ai/generation-lifecycle-service.js)

该测试运行固定版本的真实路由与生命周期源码，原生桥接及模型响应由测试替身提供，不代表真实 Tauri 应用或 Android 设备实测。第三方源码不随本仓库重新分发。


### 修复23–26日志检查

`npm test` 包含 `communication-storage.mjs`：刷新等价加载、清空、10条上限、空间不足、损坏数据及既有密钥脱敏。`npm run test:log-ui` 使用与 `test:ui` 相同的 Playwright 环境变量，验证真实页面刷新及每组复制；输出为隔离浏览器测试结果，不代表真机。最新发布代码/集成检查总数为267；完整平台复现范围见 `docs/compatibility-verification.md`。

## 单项编辑浏览器验证
`node tests/fragment-ui.mjs`（与其他 UI 脚本相同的 BLAI_TEST_MODULES / BLAI_TEST_CHROME 配置）。隔离宿主模拟保存到 localStorage，真实刷新恢复；不证明 Tauri 原生持久化。

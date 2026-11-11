# 生存者：REA 重构实验室

以用户提供的网页版游戏为架构样本，运用 REA（Reverse Engineer Anything）的静态 JavaScript 分析工作流，制作一个原创的吸血鬼幸存者风格浏览器生存游戏。演示署名：X先生。

## 启动

Node.js 20+，在项目根目录运行：

```bash
npm test
npm run serve
```

打开 `http://127.0.0.1:4173`。游戏支持 WASD/方向键移动、空格或 Shift 闪避，武器自动瞄准最近敌人；手机可用虚拟摇杆。无需安装运行时依赖。

请通过上述 HTTP 服务打开 `index.html`，避免本地模块加载限制。运行时不依赖外部图片、字体或 CDN。

## 内容

- `index.html`：启动与游戏 HUD。
- `src/`：模块化实现，分离核心循环、确定性随机数、游戏规则、Canvas 渲染和 UI。
- `src/render/canvas.js`：原创的 Canvas 2D 场景渲染，不需要外部运行时。
- `docs/`：REA 静态分析观察、限制与重构决策。
- [`docs/tutorial.md`](docs/tutorial.md)：完整 Markdown 教程（作者：X先生）。

## 版权边界

本作品是对“生存者自动攻击、移动躲避、经验升级”等类型玩法的独立实现，不复制参考网页中的港区、资产、文案、关卡或游戏代码。仅保留其自包含 HTML、Canvas、输入、HUD、启动流程和帧循环等高层架构思路。角色、怪物、地图和音效均由本项目程序化绘制/合成。REA 是分析工具，不是游戏引擎，也不负责自动生成等价实现。


- docs/own-implementation-rea-analysis.json：对本项目选定源文件完成的 REA 6.8.0 静态分析摘要和 coverage 限制。


## 验收与交付

本作采用无尽生存玩法，包含 4 种敌人、8 类升级、受伤/闪避反馈、暂停、死亡结算和重开。无账号、存档或外部运行时资源。

```bash
npm ci
npm run test:browser
npm run package
```

浏览器测试需要 Node.js 22.12+ 与本机 Chrome/Chromium；可通过 `CHROME_PATH` 指定浏览器。核心游戏与 `npm test` 不依赖 npm 安装。

浏览器报告在 `output/browser-validation.json`，截图在 `output/screenshots`。手机测试使用模拟视口和输入适配器；真实设备与多浏览器未验收。REA 自实现分析是历史快照，未对本轮修复重新扫描。

`npm run package` 生成 `output/release`，可部署其中的 `index.html`、`src/` 和 `assets/` 到静态托管服务。已通过 GitHub Pages 发布。历史 PDF 仅留作旧文件，交付以 Markdown 为准。
## 在线游玩

https://howdousethisthing.github.io/X/



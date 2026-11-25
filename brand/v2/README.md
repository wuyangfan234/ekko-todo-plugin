# Ekko ToDo — Logo V2 提案轮

6 款高端、简约、低「AI 感」的独立候选。此目录仅供选稿：**未替换现役标志，未接入 `BrandLogo.jsx` 或任何产品 UI，未修改清单与版本号。**

## 快速查看

- 双击打开 [`index.html`](./index.html)：零外部依赖，可离线使用。
- 页面右上角切换浅 / 深主题，也可用 `index.html?theme=dark` 直接打开深色版。
- 每款均包含浅 / 深底、20 / 32 / 46 / 52px 真实 UI 槽位试戴、16 / 24 / 32 / 48 / 128px 缩放、单色版与 app-icon 瓷砖试戴。
- 聊天内预览使用 `renders/contact-sheet-light.png` 或 `renders/contact-sheet-dark.png`。

## 候选清单

| 编号 | 名称 | 概念来源 | 设计取舍 | 色彩 |
| --- | --- | --- | --- | --- |
| 01 | **间隔 / Interval** | 现役 `[ ]` 括号 DNA | 删除渐变底板和对勾，只留收拢任务的括号与中心方块；以负空间建立秩序。 | 纯单色 |
| 02 | **回声 / Echo** | Ekko = echo | 一个原点只回应两次；放大弧间距、统一线宽，避免小尺寸粘连与信号图标式堆砌。 | 纯单色 |
| 03 | **字母构造 / Ekko Grotesk** | 品牌首字母 `e` | 横画兼具清单含义；自绘几何字母而非依赖字体，适合单色反相。 | 纯单色 |
| 04 | **签起 / Sign-off** | 编辑清单、签字确认 | 最后一笔向上签起，暗示完成但不复制标准对勾；缩短第二行以保持 16px 分离度。 | 纯单色 |
| 05 | **销项印 / Struck seal** | 划掉一项、封缄完成 | 实心圆缩至与线构相近的光学重量；斜向销项槽用 `<mask>` 真正掏空。 | 纯单色 |
| 06 | **次序 / Queue** | 待办到完成的任务状态变化 | 线框与实心块错位交接，透明间隙避免普通叠层感；单色模式下仍成立。 | 墨绿点缀，可单色 |

### 设计侧观察（不代替选稿）

- 01、03 更偏长期品牌识别：一个保留括号资产，一个强化 Ekko 字母资产。
- 02 直接解释名字，04 更强调人的编辑手势，05 是六款中最实心、最像印章的方向。
- 06 对「任务状态」表达最直接，也是唯一使用点缀色的候选；其点缀色不是标志成立的必要条件。

## 文件索引

```text
brand/v2/
├── index.html                         # 离线详细对比页
├── README.md                          # 本说明
├── masters/
│   ├── ekko-v2-01.svg                 # 间隔
│   ├── ekko-v2-02.svg                 # 回声
│   ├── ekko-v2-03.svg                 # 字母构造
│   ├── ekko-v2-04.svg                 # 签起
│   ├── ekko-v2-05.svg                 # 销项印
│   └── ekko-v2-06.svg                 # 次序
└── renders/
    ├── ekko-v2-01-1024.png            # 每款均有 1024px 透明母版
    ├── ekko-v2-01-16.png              # 每款均有 16px sanity render
    ├── ekko-v2-01-24.png              # 每款均有 24px sanity render
    ├── ekko-v2-01-32.png              # 每款均有 32px sanity render
    ├── ekko-v2-01-48.png              # 每款均有 48px sanity render
    ├── …                              # 02—06 同规则命名，共 30 张候选 PNG
    ├── contact-sheet-light.png        # 1600px 宽浅色联络表
    ├── contact-sheet-dark.png         # 1600px 宽深色联络表
    ├── proof-light.png                # 真实 Chromium 浅色整页截图
    └── proof-dark.png                 # 真实 Chromium 深色整页截图
```

## 母版技术约定

- 全部 SVG 使用 `viewBox="0 0 100 100"`，基础墨色为 `currentColor`，可作为独立 `<img>` 正常解码。
- 06 的点缀色变量为 `--ekko-accent`，浅色默认 `#274c43`；对比页深色主题使用较亮的 `#a7bdb2` 保持可见性。
- 05、06 的镂空均由 `<mask>` 形成，不以背景色补丁模拟透明。
- 无渐变、发光、投影、玻璃拟态、星星、机器人或电路装饰。
- PNG 由本机 Chromium 真实栅格化，背景透明；小尺寸不是将 1024px 位图缩小，而是从对应 SVG 母版按目标尺寸重新渲染。

## 提案边界

本轮没有修改 `assets/logo.svg`、`assets/logo.png`、`src/client/components/BrandLogo.jsx`、`plugin.json` 或其他现有产品文件。选定候选后，另开落地单处理 UI 接入、favicon / manifest 导出与最终回归。

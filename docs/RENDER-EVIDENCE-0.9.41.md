# Render evidence for 0.9.41 (Todo #19: @ picker in the chat composer)

This file records what a real browser rendered and measured for the `@` Agent picker fix. It holds numbers copied from the measurement JSON files and the list of screenshots. The screenshots themselves are not in the repository.

## What was rendered

- The real `src/client/components/ChatPane.jsx` and `src/client/styles.css`, bundled with esbuild and mounted on a page with placeholders for the sidebar and the board. **It is not the whole application and it is not inside the Studio host iframe.**
- Fixture: one topic with two messages and four Agents (`a-chief` 大总管, `a-dev` 平台主程, `a-rev` 审查员, `a-plan` Planner). `onSendMessage` stores each payload in `window.__sends`. The page `?agents=0` has no Agents.
- "Before" is `main` at `272d342` (v0.9.38). "After" is the source of this branch at commit `94d57c6`, before `main` `0c5e174` (v0.9.40, sidebar styles) was merged into it. The tables and the screenshot list below come from that run.
- After the merge the two "after" runs (Chromium and WebKit) were repeated on the merged source. Apart from the millisecond readings, every recorded state was the same as in the tables below, with 0 console errors. That run's JSON files and 24 screenshots are in `~/.hermes/workspace/ekko-todo-evidence/todo19-v0941-r4`.
- Input is real: mouse clicks or touch taps at the centre of the element, and keyboard events, sent by Playwright (Python, 1.58.0).

## Not tested

- No real phone. The iPhone run is desktop WebKit with the iPhone 13 device settings; there is no system soft keyboard.
- No input-method composition. Chinese text and the full-width `＠` were inserted as finished text.
- Light theme only.
- Not rendered inside the Studio host, and not deployed.

## Environments

| Name | Browser | Viewport set in Playwright (CSS px) | `innerWidth` read on the test page | DPR | Input |
|---|---|---|---|---|---|
| Desktop 1440×900 | chromium 153.0.8010.12 | 1440×900 | 1440 | 2 | Chromium, mouse |
| Phone 390×844 | chromium 153.0.8010.12 | 390×844 | 390 | 2 | Chromium, touch (`has_touch`, `is_mobile`) |
| iPhone 13 390×844 | webkit 26.0 | Playwright `iPhone 13` device | 390 | 3 | WebKit, touch |

Console errors and page errors, all four runs: before chromium 0, before webkit 0, after chromium 0, after webkit 0.

## The picker stays open after the @ button is pressed

Steps: focus the text box, insert `你好`, press the `@` button, then read the page state 100 ms, 800 ms and 1500 ms after the press. Each cell is: milliseconds since the press measured in the page (`performance.now()`), whether the picker is in the DOM, how many Agent rows it has, and whether the text box has focus.

**After (this branch)**

| Environment | 100 ms | 800 ms | 1500 ms | Text box |
|---|---|---|---|---|
| Desktop 1440×900 | 111 ms · open=true · 4 rows · focused=true | 811 ms · open=true · 4 rows · focused=true | 1511 ms · open=true · 4 rows · focused=true | `"你好 @"` |
| Phone 390×844 | 109 ms · open=true · 4 rows · focused=true | 811 ms · open=true · 4 rows · focused=true | 1511 ms · open=true · 4 rows · focused=true | `"你好 @"` |
| iPhone 13 390×844 | 112 ms · open=true · 4 rows · focused=true | 802 ms · open=true · 4 rows · focused=true | 1502 ms · open=true · 4 rows · focused=true | `"你好 @"` |

**Before (`272d342`)**

| Environment | 100 ms | 800 ms | 1500 ms | Text box |
|---|---|---|---|---|
| Desktop 1440×900 | 110 ms · open=true · 4 rows · focused=true | 810 ms · open=false · 0 rows · focused=true | 1511 ms · open=false · 0 rows · focused=true | `"你好 @"` |
| Phone 390×844 | 110 ms · open=true · 4 rows · focused=true | 811 ms · open=false · 0 rows · focused=true | 1512 ms · open=false · 0 rows · focused=true | `"你好 @"` |
| iPhone 13 390×844 | 112 ms · open=true · 4 rows · focused=true | 811 ms · open=false · 0 rows · focused=true | 1503 ms · open=false · 0 rows · focused=true | `"你好 @"` |

## Events the @ button received

Capture-phase listeners on the button recorded this sequence for the one press above. `:prevented` would be appended to an event whose default was already prevented when the listener ran; the capture listener runs before React's `onMouseDown`, so it is not expected here.

| Environment | Before | After |
|---|---|---|
| Desktop 1440×900 | mousedown → mouseup → click | mousedown → mouseup → click |
| Phone 390×844 | touchstart → touchend → mousedown → mouseup → click | touchstart → touchend → mousedown → mouseup → click |
| iPhone 13 390×844 | touchstart → touchend → mousedown → mouseup → click | touchstart → touchend → mousedown → mouseup → click |

On both touch environments the tap produced `mousedown` and then `click`. In the "after" runs the button's `onMouseDown` calls `preventDefault()`, and `click` was still dispatched: the picker opened (table above) and the text box kept focus.

## Key scenarios

`sends` is the number of payloads `onSendMessage` had received when the state was read.

### Desktop 1440×900 (chromium 153.0.8010.12)

| Step | Before (`272d342`) | After (this branch) |
|---|---|---|
| Button path: tap 平台主程 in the open picker | — | text `"你好 @平台主程 "` · open=false · focused=true · sends=0 |
| Button path: then insert `看一下`, Enter — payload | — | `[{"text": "你好 @平台主程 看一下", "mentionedAgentIds": ["a-dev"]}]` |
| Typed path: `交给` then `@` | text `"交给@"` · open=false · focused=true · sends=0 | text `"交给@"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: then `平` | text `"交给@平"` · open=false · focused=true · sends=0 | text `"交给@平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: tap 平台主程 | — | text `"交给@平台主程 "` · open=false · focused=true · sends=0 |
| Typed path: then insert `修一下`, Enter — payload | — | `[{"text": "交给@平台主程 修一下", "mentionedAgentIds": ["a-dev"]}]` |
| No match: type `@zhang` | text `"@zhang"` · open=false · focused=true · sends=0 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Enter | text `""` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Shift+Enter | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Esc | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=false · focused=true · sends=0 |
| No match: then Enter again — payloads so far | `[{"text": "@zhang", "mentionedAgentIds": []}]` | `[{"text": "@zhang", "mentionedAgentIds": []}]` |
| No match: fresh page, `@zhang`, Tab, 500 ms | text `"@zhang"` · open=false · focused=false · sends=0 | text `"@zhang"` · open=false · focused=false · sends=0 |
| With matches: `@`, ArrowDown, Enter | text `"@平台主程 "` · open=false · focused=true · sends=0 | text `"@平台主程 "` · open=false · focused=true · sends=0 |
| Button again: type `hello @平` | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入）` · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press the button | text `"hello @平 @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press it once more, 900 ms | text `"hello @平 @ @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: insert `你好` then `＠` | text `"你好＠"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then `平` | text `"你好＠平"` · open=false · focused=true · sends=0 | text `"你好＠平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then Enter | — | text `"你好@平台主程 "` · open=false · focused=true · sends=0 |
| Full-width: then insert `看`, Enter — payload | — | `[{"text": "你好@平台主程 看", "mentionedAgentIds": ["a-dev"]}]` |
| Full-width: fresh page, `你好＠`, press the button | text `"你好＠ @"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |

### Phone 390×844 (chromium 153.0.8010.12)

| Step | Before (`272d342`) | After (this branch) |
|---|---|---|
| Button path: tap 平台主程 in the open picker | — | text `"你好 @平台主程 "` · open=false · focused=true · sends=0 |
| Button path: then insert `看一下`, Enter — payload | — | `[{"text": "你好 @平台主程 看一下", "mentionedAgentIds": ["a-dev"]}]` |
| Typed path: `交给` then `@` | text `"交给@"` · open=false · focused=true · sends=0 | text `"交给@"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: then `平` | text `"交给@平"` · open=false · focused=true · sends=0 | text `"交给@平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: tap 平台主程 | — | text `"交给@平台主程 "` · open=false · focused=true · sends=0 |
| Typed path: then insert `修一下`, Enter — payload | — | `[{"text": "交给@平台主程 修一下", "mentionedAgentIds": ["a-dev"]}]` |
| No match: type `@zhang` | text `"@zhang"` · open=false · focused=true · sends=0 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Enter | text `""` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Shift+Enter | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Esc | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=false · focused=true · sends=0 |
| No match: then Enter again — payloads so far | `[{"text": "@zhang", "mentionedAgentIds": []}]` | `[{"text": "@zhang", "mentionedAgentIds": []}]` |
| No match: fresh page, `@zhang`, Tab, 500 ms | text `"@zhang"` · open=false · focused=false · sends=0 | text `"@zhang"` · open=false · focused=false · sends=0 |
| With matches: `@`, ArrowDown, Enter | text `"@平台主程 "` · open=false · focused=true · sends=0 | text `"@平台主程 "` · open=false · focused=true · sends=0 |
| Button again: type `hello @平` | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入）` · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press the button | text `"hello @平 @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press it once more, 900 ms | text `"hello @平 @ @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: insert `你好` then `＠` | text `"你好＠"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then `平` | text `"你好＠平"` · open=false · focused=true · sends=0 | text `"你好＠平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then Enter | — | text `"你好@平台主程 "` · open=false · focused=true · sends=0 |
| Full-width: then insert `看`, Enter — payload | — | `[{"text": "你好@平台主程 看", "mentionedAgentIds": ["a-dev"]}]` |
| Full-width: fresh page, `你好＠`, press the button | text `"你好＠ @"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |

### iPhone 13 390×844 (webkit 26.0)

| Step | Before (`272d342`) | After (this branch) |
|---|---|---|
| Button path: tap 平台主程 in the open picker | — | text `"你好 @平台主程 "` · open=false · focused=true · sends=0 |
| Button path: then insert `看一下`, Enter — payload | — | `[{"text": "你好 @平台主程 看一下", "mentionedAgentIds": ["a-dev"]}]` |
| Typed path: `交给` then `@` | text `"交给@"` · open=false · focused=true · sends=0 | text `"交给@"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: then `平` | text `"交给@平"` · open=false · focused=true · sends=0 | text `"交给@平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Typed path: tap 平台主程 | — | text `"交给@平台主程 "` · open=false · focused=true · sends=0 |
| Typed path: then insert `修一下`, Enter — payload | — | `[{"text": "交给@平台主程 修一下", "mentionedAgentIds": ["a-dev"]}]` |
| No match: type `@zhang` | text `"@zhang"` · open=false · focused=true · sends=0 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Enter | text `""` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Shift+Enter | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=true · 0 rows · head `没有匹配的 Agent（Esc 关闭）` · hint `没有名字含「zhang」的 Agent，换个字试试` · focused=true · sends=0 |
| No match: then Esc | text `"\n"` · open=false · focused=true · sends=1 | text `"@zhang"` · open=false · focused=true · sends=0 |
| No match: then Enter again — payloads so far | `[{"text": "@zhang", "mentionedAgentIds": []}]` | `[{"text": "@zhang", "mentionedAgentIds": []}]` |
| No match: fresh page, `@zhang`, Tab, 500 ms | text `"@zhang"` · open=false · focused=false · sends=0 | text `"@zhang"` · open=false · focused=false · sends=0 |
| With matches: `@`, ArrowDown, Enter | text `"@平台主程 "` · open=false · focused=true · sends=0 | text `"@平台主程 "` · open=false · focused=true · sends=0 |
| Button again: type `hello @平` | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入）` · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press the button | text `"hello @平 @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Button again: press it once more, 900 ms | text `"hello @平 @ @"` · open=false · focused=true · sends=0 | text `"hello @平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: insert `你好` then `＠` | text `"你好＠"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then `平` | text `"你好＠平"` · open=false · focused=true · sends=0 | text `"你好＠平"` · open=true · 1 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |
| Full-width: then Enter | — | text `"你好@平台主程 "` · open=false · focused=true · sends=0 |
| Full-width: then insert `看`, Enter — payload | — | `[{"text": "你好@平台主程 看", "mentionedAgentIds": ["a-dev"]}]` |
| Full-width: fresh page, `你好＠`, press the button | text `"你好＠ @"` · open=false · focused=true · sends=0 | text `"你好＠"` · open=true · 4 rows · head `选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）` · focused=true · sends=0 |

`—` means the step was not run because the step before it left nothing to act on (for example, no picker to tap).

## Screenshots

Directory: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3`. The files are not committed. Paths are written from the home directory (`~`) of the machine that produced them, because this repository does not allow user home paths in tracked files. File names are `<before|after>-<engine>-<environment>-<scene>.png`.

### After (this branch)

**Desktop 1440×900**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-S-button-t1500ms.png`
- Button path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-S-button-picked.png`
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-T-typed-open.png`
- Typed path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-T-typed-picked.png`
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-desktop-FW-fullwidth-open.png`

**Phone 390×844**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-S-button-t1500ms.png`
- Button path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-S-button-picked.png`
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-T-typed-open.png`
- Typed path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-T-typed-picked.png`
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-chromium-m390-FW-fullwidth-open.png`

**iPhone 13 390×844**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-S-button-t1500ms.png`
- Button path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-S-button-picked.png`
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-T-typed-open.png`
- Typed path, Agent picked: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-T-typed-picked.png`
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/after-webkit-iphone390-FW-fullwidth-open.png`

### Before (`272d342`)

**Desktop 1440×900**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-S-button-t1500ms.png`
- Button path, Agent picked: not taken (the step was not reached)
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-T-typed-open.png`
- Typed path, Agent picked: not taken (the step was not reached)
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-desktop-FW-fullwidth-open.png`

**Phone 390×844**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-S-button-t1500ms.png`
- Button path, Agent picked: not taken (the step was not reached)
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-T-typed-open.png`
- Typed path, Agent picked: not taken (the step was not reached)
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-chromium-m390-FW-fullwidth-open.png`

**iPhone 13 390×844**

- Button path, 100 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-S-button-t100ms.png`
- Button path, 800 ms after the press: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-S-button-t800ms.png`
- Button path, 1500 ms after the press (open state): `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-S-button-t1500ms.png`
- Button path, Agent picked: not taken (the step was not reached)
- Typed path, picker open after `交给@`: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-T-typed-open.png`
- Typed path, Agent picked: not taken (the step was not reached)
- `@zhang`, after Enter: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-N-no-match-after-enter.png`
- `你好＠`, picker open: `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/before-webkit-iphone390-FW-fullwidth-open.png`

42 PNG files in total.

## How to run it again

The fixture and the script are in the same directory as the screenshots, outside the repository: `entry.tpl.jsx` (mounts `ChatPane` with the fixture), `index.html`, `build.sh` (bundles "before" from `git archive 272d342` and "after" from the worktree's `src/client`) and `measure.py`. `build.sh` and `measure.py` contain absolute paths to the worktree, the scratch directory and the Playwright browser cache of the machine they were written on; change them before running elsewhere.

```bash
S=~/.hermes/cache/scratch/todo19-r3   # scratch directory named inside build.sh
mkdir -p $S/before $S/after $S/before-src && cp ~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3/{entry.tpl.jsx,index.html,build.sh,measure.py} $S/
sh $S/build.sh
cd $S && for v in before after; do for e in chromium webkit; do /usr/bin/python3 measure.py $v $e; done; done
```

Each run writes `<before|after>-<engine>-measure.json` and its screenshots to `~/.hermes/workspace/ekko-todo-evidence/todo19-v0939-r3`. The tables above were generated from those four JSON files.

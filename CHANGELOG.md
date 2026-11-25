# Changelog

All notable changes to **Ekko ToDo** are documented in this file.

## [0.9.58] - 2026-11-25

对照成熟的开源多 Agent 调度框架（LangGraph supervisor、OpenAI Agents SDK、OpenHands、CrewAI、AutoGen）复审后吸收的一项改进，不改结构。

### Changed
- **子 Agent 交卷时，它自己的最后答复随通知一起交给总管。** LangGraph 的 supervisor 和 OpenAI Agents SDK 的「agent 当工具用」都把子 Agent 的最终输出直接交还调度者。Ekko 以前的通知只有阶段、测试和审查结论，还明确让总管「先用 get_todo_conversation 看输出」：一个真实话题里总管被唤醒 27 次，18 次第一步就是去读整段执行对话。现在每轮结算把子 Agent 本轮最后一条答复存进卡片（`evidence.workerReport`，最多 3000 字，失败和空转的轮次也存），通知里以引用块附上；审查给了结论时，审查意见（`reviewSummary`，最多 1200 字）也一并附上。通知改为「报告已在上面，只有缺失或被截断时才去读对话」。新一轮派发会清空上一轮的报告。调研 / 内容 / 部署卡的成果本来就附在通知里，不重复。

### Fixed
- 执行对话里工具的输出被标成「任务指令」（如「任务指令：{"output": "GATE_RC=0"}」）。现在标为「工具结果」。

### Not changed
- 复审过但没有吸收的：
  - LangGraph `RetryPolicy` 式的同配置退避重试：Hermes 每次模型调用已自带最多 3 次重试（日志 `attempt 1/3`），插件再叠一层只会拉长失败；本机记录里也没有限流 / 5xx 导致的卡片失败。
  - OpenHands StuckDetector 的「同一动作同一报错」检测：Hermes 自带同类保护（重复读文件拦截、`idempotent_no_progress_warning`）；它的「每个卡死段只催一次」与 0.9.57 的空转催促做法一致。
  - CrewAI 任务 guardrail（输出校验 + 带反馈重试）：与 0.9.57 的空转催促、0.9.55 的成果判定已对应。
  - AutoGen 可组合终止条件：插件已有的回合中止（循环、越界、空转）都按单一条件触发，组合化需要改结构，不做。
- 数据库、契约与 RPC 没有改；宿主 Hermes 没有改。

## [0.9.57] - 2026-11-25

按一个真实话题（天机阁项目，#13–#20）逐张卡、逐个会话原始记录取证后修的一批判定与派发问题。

### Fixed
- **模型名写错时每轮都失败，却被报成「模型返回空响应」。** 总管用 `configure_agent` 把模型写成了 `kimi-coding/kimi-coding/k3.1-pro`（provider 前缀重复）和 provider `custom` + `custom:magpie-jp/kiro/claude-opus-5.5`，宿主请求返回 404 model_not_found，五轮构建 2 秒内结束。现在：保存 Agent 时先规范化（去掉重复的 provider 前缀；`custom` + `custom:<池>/…` 拆成 provider `custom:<池>` 与模型 `…`），Hermes 配置再对照 Studio 可用模型目录校验，不在目录里的拒绝保存并给出相近的可选项；已经存进去的旧配置在启动会话时也按同样规则清洗。运行失败时若本轮没有任何模型输出，先查模型在不在目录，不在就直接写明「不在 Studio 可用模型目录中（404）」，并按可切换故障交给备选模型。
- **Agent 没有系统提示时，派工一律「启动失败：value.instructions: expected JSON data」。** 启动参数里传了 `instructions: undefined`，宿主拒收。现在没有系统提示就不带这个字段（构建、审查、审查续跑三处）。
- **宿主写的失败行被当成模型的回复。** Hermes 在一轮失败时会写一条「Your request was not processed…」，插件把它当成助手正文：调研卡会把它当成果交付，诊断也读不出失败。现在这类行单独识别，不算回复；在总管话题里显示为一条系统提示。
- **子 Agent 只说一句打算就结束本轮，被直接判失败。** 记录里大量回合以「改用…；先提交脚本再运行。」「我会严格按…逐文件提交」收尾、零工具调用。现在这种空转回合先在**同一会话、同一模型**里自动催促一次（写明立刻动手修改并提交、不要以「接下来 / 我会」结束），催促后仍无产出才按空转判失败或换备选。方案轮、部署卡、调研卡各有对应的催促语。
- **部署卡按「有没有新提交」判成败。** 部署改的是服务器不是仓库，做对了也被判失败。现在部署卡和调研 / 内容卡一样：本轮没改仓库、但最后一条回复是部署报告时，进「部署已执行 · 待验收」，报告存进卡片；默认由人验收（项目允许总管验收部署时才交给总管）。
- **调研 / 内容卡分支上已有之前各轮的提交时，被当成纯文字成果结束，那些提交永远不会合并。** 现在只有分支相对基线完全没有改动时才按文字成果交付；否则走普通构建结果（可审查、可合并），本轮的文字报告附在卡上。
- **审查会话在多轮审查间复用，新一轮没写任何字时读到上一轮的 `VERDICT: APPROVED`，没人看过的代码被判通过。** 现在只认本轮的回复；正在催审查给结论时仍以被催的那条为准（#50 的重复判定不变）。
- **方案轮没给出方案也进「方案待批准」，批准后从空方案开工。** 现在先催一次，仍没有方案就判失败。
- **一张卡空转自动换备选重跑的额度用掉一次就永久没了**，后面有产出的回合也不恢复。现在有产出的回合恢复这一次额度。
- **总管越界拦截漏了 `skill_manage` / `cronjob_manage`**：记录里总管两次用 `skill_manage` 改了项目技能文件，守卫没拦。现在这两个算写操作，`browser_cdp`、`browser_dialog`、`close_terminal`、`image_generate`、`video_generate` 算自己执行。
- 总管发的补充指令在时间线上写成「user 发送补充指令」。现在写「总管发送补充指令」，执行者为 chief。

### Changed
- 卡片连续失败两轮及以上时，给总管的通知里写明「已连续失败 N 轮，不要原样再派；先看执行对话，改模型 / 缩任务书 / 换 Agent 或问用户」。记录里同一张卡 6 分钟内被原样重派 7 次。
- 给部署卡子 Agent 的开头写明：不改仓库也是有效结果，必须真的执行部署，最后一条回复写目标、命令和线上验证输出。

### Not changed
- 代码卡空转的判定标准不变（HEAD 与工作树都没变）；只是在判失败前多一次同会话催促。数据库与 RPC 契约没有改（新字段都在已有 evidence 里）；宿主 Hermes 没有改。

## [0.9.56] - 2026-11-25

### Fixed
- 总管其实没在运行（运行记录里不是活跃会话），对话区却一直显示「大总管正在响应…」并持续计时，输入框提示「运行中，发送将自动排队」，点「停止」也没有反应。原因是页面在发出消息的那一刻、以及收到宿主「开始运行 / 已排队」时，会自己记一个「运行中」，而这个记号只有收到宿主的「运行完成 / 失败 / 中止」事件才会清掉。宿主没有真正跑这一轮时（排队项被丢弃、启动被拒、订阅断开期间这一轮已经结束、对已经空闲的会话点停止——宿主这时什么事件都不发），记号就永远不清。现在：
  - 页面记下最后一次收到宿主事件的时间。看板显示话题既不在运行也不在启动、且宿主连续 20 秒没有任何事件时，先向宿主再确认一次会话状态（`sync-topic-session`），确认空闲后清掉「正在响应」。真正在跑的回合不受影响：只要看板或宿主任何一方说还在跑，就不清。
  - 点「停止」成功后立即清掉页面上的「正在响应」，不再等宿主事件。
  - 清掉时，已经流式显示但还没存进记录的回复照旧保留（与正常结束同一套处理），不会一闪就没。
- 整页真渲染复现：宿主订阅连上后不再发任何事件，发一条消息。修复前 30 秒后仍显示「大总管正在响应… 30s」，点停止后仍在计时；修复后约 20–25 秒自动消失，点停止立即消失。

### Changed
- `plugin.json` 补上 `repository` 字段（公开仓地址），插件详情页可以直接链到仓库。

### Not changed
- 插件中心显示「暂无法确认更新」不是插件出错：Studio 只拿官方云端插件目录做版本比对，Ekko ToDo 尚未提交进该目录，所以无从比较。从 GitHub 链接重新安装即可升级到最新版本。服务端、契约与数据库没有改；宿主 Hermes 没有改。

## [0.9.55] - 2026-11-25

### Fixed
- 调研类任务（只调研、不改代码）跑完后被判成「运行失败」：时间线写「本轮没有产生任何提交（HEAD 仍为 …），任务未推进」，而子 Agent 在最后一条回复里其实已经交了调研结论。原因是 0.9.47（#36）的产出校验只看 HEAD 和工作树有没有变，对所有卡片一视同仁。现在类型为「调研 / 方案」（`question`）或「内容」（`content`）的卡片，本轮没改任何文件、但本轮最后一条回复是一份成果（去掉空白后至少 40 字）时，卡片进入「待验收」（关口 `deliverable`），成果原文存进卡片（`evidence.deliverable`，超过 2 万字截断，全文仍在执行对话里），详情页「任务规格」页签里显示「交付成果（文字报告）」。这类卡片不跑验收命令、不走审查和合并：按钮是「验收完成」和「补充调研」；对它调用合并会被拒并说明原因。话题开了 AUTO 时由总管验收：通知里直接附上成果（前 6000 字），并要求它对照任务书用 `complete_todo` 结束或用 `message_todo` 补充，不要调审查和合并。
- 只认本轮的回复：之前某一轮留下的报告不算本轮成果；本轮只回了一句状态（如「好的，开始调研。」）或被停止，照旧按空转处理。

### Changed
- 代码类卡片的空转判定不变（仍会自动换备选重跑一次或判失败），但本轮最后的文字回复不再丢：时间线记一条「本轮未改代码，但留下了 N 字文字输出（「…」，全文见执行对话）」，并提示如果这本来是调研任务，把类型改为「调研 / 方案」后重派。
- 给子 Agent 的任务开头按类型区分：调研 / 内容卡写明「不需要改代码，最后一条回复原样作为交付成果，先结论后依据」。
- 总管提示词写明：调研 / 评估 / 方案类工作同样建卡派工，类型用 `kind="question"`（文字内容用 `content`），读完成果后 `complete_todo` 验收。`create_todo` / `update_todo` 的类型说明同步，并补上一直缺的 `content`。
- 建卡时没给类型：标题像调研（调研、研究、评估、选型、可行性、对比分析、竞品、摸底、research、investigate、survey、evaluate）记为「调研 / 方案」，其余仍是「功能」。总管显式给的类型照旧。
- 界面文案：类型「方案 / 决策」改为「调研 / 方案」（新建对话框里注明「不改代码」），项目页筛选「确认」改为「调研」；卡片状态显示「成果已交付 · 待你验收」/「成果已交付 · 总管验收中」；通知「调研成果已交付，待你验收」。

### Not changed
- 调研卡如果本轮确实提交了文件（例如写了 `report.md`），照普通卡片走：跑验收命令、可审查、可合并。数据库、契约模型与 RPC 没有改（`deliverable` 存在已有的 evidence 里）；没有迁移。宿主 Hermes 没有改。

## [0.9.54] - 2026-11-25

### Fixed
- 干净的新机器（没装 gh）上，在「从 GitHub 导入」对话框里配置 GitHub 访问令牌，一点「校验并连接」插件就白屏，令牌也没存上。原因是令牌输入框本身是一个 `<form>`，而它又放在导入对话框自己的 `<form>` 里面；表单套表单在 HTML 里不合法，浏览器绕过 React 直接做了原生提交，整页被重新加载（地址变成 `…?`），保存请求根本没发出去。现在令牌输入区不再是表单：点按钮或在输入框按回车直接保存，事件不再冒泡到外层表单。整页真渲染复现：修复前点击后页面跳走、`github-auth-save-token` 未调用；修复后保存成功、卡片显示「已连接」、仓库列表随即加载。
- 插件界面任何一处渲染出错都会让整页变成空白。现在最外层有错误边界：出错时显示错误原因和「重新加载界面」按钮，数据不受影响。
- Windows 上所有 git / gh 调用拿到的 PATH 是坏的：插件按 `:` 拆 PATH，把 `C:\Windows` 拆成 `C` 和 `\Windows`，又额外写入一个 `PATH` 键与系统的 `Path` 并存。现在按系统分隔符（Windows 用 `;`）拆分、沿用原有的键名，并在 Windows 上补充 Git for Windows / GitHub CLI / Scoop 的常见目录，识别 `.exe` / `.cmd`。

### Changed
- 用量与订阅面板的本机凭据改为跨平台查找（新文件 `src/server/credential-paths.mjs`）：每个提供方按「CLI 自己的目录环境变量 → 本系统默认目录」依次找，Windows / Linux / macOS 都适用，路径用本系统的分隔符拼接。环境变量覆盖：`CODEX_HOME`、`CLAUDE_CONFIG_DIR`（Linux 另查 `$XDG_CONFIG_HOME/claude`）、`GEMINI_CLI_HOME`、`GROK_HOME`、`KIMI_SHARE_DIR`（Kimi 配置另查 `$XDG_CONFIG_HOME/kimi`、Windows `%APPDATA%\kimi`）。macOS 钥匙串只在 macOS 上读，其他系统不会去调 `security`。任何一个候选文件读不到或格式不对都只是跳过，不会报错到界面。
- 本机 CLI 找不到登录态时，回落读 Ekko Studio 自己的登录凭据（Hermes 主目录的 `auth.json` 与 `.env`；主目录按 Hermes 的规则找：`HERMES_HOME` → Windows `%LOCALAPPDATA%\hermes` → `~/.hermes`，非默认 profile 先查 `profiles/<名字>`）。对应关系：Codex ← `openai-codex`，Claude ← `anthropic`（只接受 OAuth 令牌），Grok ← `xai-oauth`，Antigravity ← Google OAuth 令牌，Kimi / DeepSeek / OpenRouter ← `.env` 里的密钥。卡片上的来源写「Ekko Studio 凭据」；本机和 Studio 都没有时，提示去对应 CLI 或 Ekko Studio 登录，或手动填密钥。Grok 用 Studio 的 `xai-oauth` 令牌查额度已在本机实测返回 200。
- 「总管不直接改代码」从提示加告警改为运行时强制：开启时，总管一调用写文件 / 改补丁、终端 / 执行代码 / 浏览器自动化、子代理（`delegate_task` 等）类工具，本轮立即中止，话题里留一条「总管越界，已中止本轮…」，并自动给总管发一条纠偏指令（改为 `create_todo` + `run_build` 派工，或直接回复用户）。通过 `tool_call` 包装调用的工具也按里面的真实工具判断。同一条用户消息之后最多自动纠偏 2 次，再越界就只停下、等用户发「继续」。以前只在「写入路径落在项目仓库里」时追加一条告警，不会停。
- 总管连续只读调查（读文件、搜代码、查网页等）超过上限还没派工，同样中止本轮并纠偏；读看板（`list_todos`、`get_todo_diff`、`inspect_project_repo` 等 Ekko ToDo 自己的工具）不算调查，派工后计数清零。上限默认 8 次，可在「配置中心 → 总管与章程」改为 4 / 8 / 12 / 20 次。
- 总管的思考等级加上限：严格编排开启时默认不超过「中」（原来设成「最大」的也按「中」跑，会话模型也按「中」设置），可在同一处改为低 / 中 / 高 / 极高 / 不限制。
- 总管提示词的约束段重写为「派工员而不是干活的人」：只做理解意图 → 写任务书 → 派工 → 验收 → 汇报；写明越界调用会被运行时中止、能写出验收标准就立刻派工、少做长推理。思路参考 LangGraph supervisor、OpenAI Agents SDK 的 handoff，以及 Claude Code 编排者 / 子代理的分工。

### Not changed
- 关闭「总管不直接改代码」后行为与以前一致：不拦截、不计调查次数、不封顶思考等级；轮询等待（sleep 循环）的原有处理仍在。Worker 与审查 Agent 的工具和思考等级没有改。宿主 Hermes 没有改。
- 新增设置字段 `chiefEffortCap`、`chiefInvestigationLimit`（数据库两列，老库自动补列，默认「中」/ 8 次）；没有其他迁移。

## [0.9.53] - 2026-11-25

### Fixed
- 总管回复时，思考框里的思考仍会整段出现两遍（#49 只把状态行挪走了，没有治这一条）。原因是宿主遇到「模型返回空回复」会在同一轮里重试（最多 3 次），每次重试都把思考从头再流一遍，而插件一直往同一个思考框里追加。现在宿主发出「开始新一次尝试」的状态行时，思考框先清空，下一次尝试的思考从头显示；状态行本身显示在运行状态条里，不进思考框。认作新尝试的状态行：`⚠️ Empty response from model — retrying (1/3) in 5.8s` 这类「…retrying…」、`… — trying fallback...`（含 `Max retries (n) exhausted — trying fallback...`）、`🔄 Codex soft failure (…) — switched to the next pool credential, retrying...`；只提到「retrying won't help」的失败说明不算。同一段合成事件（5 字思考 → 重试状态行 → 同样 5 字思考）修复前思考框 10 个字，现在 5 个字。
- 同一回合的回复帧到达两次（断线重连回放、被取代的尝试重发已发过的部分、第二条连接）时，回复正文会并排出现两份。宿主给 `message.start` / `message.delta` / `message.interim` 带了身份：`turn_id`（回合）、`segment`（段号）、`offset`（这段里已发出的 UTF-16 码元数）。现在插件按这个身份合并：已经贴过的部分丢掉，只补新的尾巴；一段被 `message.interim` 封口后，重发的封口和这一段的旧帧都不再贴；`turn_id` 换了说明是新回合，回复和思考整块重新开始。同一组 3 帧重发一遍，修复前回复 22 个字，现在 11 个字。

### Changed
- 一段回复封口（`message.interim` 带身份）时，思考框随之清空：下一步模型调用的思考是新的一段。宿主标明「已流式发过」（`already_streamed: true`）的封口文本，按宿主同样的口径比较（连续空白并成一个空格、去掉首尾空白）：和已显示的正文一样或是它的前一部分时不再追加，正文原样保留（开头的空行、结尾的换行都不动）；比正文多出一截时只补多出的那截；完全对不上时照旧追加。没标「已流式发过」的封口和以前一样补上。
- `offset` 按 UTF-16 码元计，和宿主一致；emoji、跨两帧拆开的代理对、长中文文本都按码元切，不会切出半个字符。

### Not changed
- 没带身份字段、或字段不合法（`turn_id` 不是非空字符串，`segment` / `offset` 不是非负整数）的帧，照旧直接追加；畸形输入不会抛错。`reasoning.delta` 宿主不带身份，仍逐块追加，只在上面说的尝试边界清空。漏掉的帧不会被之后的重放补回：每一段只记到达过的最远位置，重放的旧帧都在它前面，会被丢掉。普通状态行（如 `(◕‿◕) pondering...`）不清空思考。
- 只改了客户端的流式缓冲（`src/client/stream-events.js`，`src/client/App.jsx` 在回合开始和重连回放清空缓冲时一并清空身份记录）。已保存的消息、运行记录（`get-session-trace` 读的是落库消息，本来就只有一份）、契约的模型 / RPC / 工具、数据库和服务端都没有改；没有迁移。宿主 Hermes 没有改。

## [0.9.52] - 2026-11-25

### Fixed
- 审查没给结论、平台去催它收口时，如果宿主回答「这个会话已经有一轮在跑」（already running），这次催促其实没有发出去，卡片却记成了「已催过一次」：时间线写 `审查未给出结论，已要求它收口（…1/1）`，运行号被清空。等那一轮结束、仍没结论时，卡片写「审查两次都没有给出结论」，而实际只有一个回合没给结论。现在这种情况什么都不写：不计次数，不写「已要求它收口」，卡片保持「审查中」，等正在跑的那一轮结束后再结算，那时仍可以催一次。启动调用超时、但宿主其实接下了这一轮的情况不受影响，仍按已发出记。
- 同一个审查回合的结束被报告两次时（没有新的回复），第二次会把卡片直接送到「需人工」关口并写「审查两次都没有给出结论」；审查方随后回的 `VERDICT: APPROVED` 因为卡片已不在「审查中」而被丢掉。现在催促发出时把那条回复的编号记在 `evidence.reviewInconclusiveTurn`；再次结算读到的还是同一条回复时，先问宿主这个审查会话是否还在跑：还在跑（或宿主答不上来）就什么都不改，等催出来的那一轮结束再判；已经空闲，就把审查会话的最后一条回复重新读一遍：还是原来那条，说明催出来的那一轮一个字没写就结束了，照旧进「需人工」关口；已经换成新的一条（催出来的那一轮在询问宿主的这段时间里答完了），就按新的这条判结论，不会因为它的结束通知撞上正在进行的结算而丢掉。这段时间里到达的结束通知会先记下来交给这次结算：催出来的那一轮如果是以失败结束的（`chat.run.failed`），卡片按「审查运行失败」写，带上失败原因，不会因为会话里已经有一条 `VERDICT: APPROVED` 就判成通过、进到可合并关口；失败前没写正文时也记成失败，而不是普通的「没有结论」。宿主是否真的会对同一回合重复报告结束，没有实测到过；这一条是防御。
- 审查回复没有 `VERDICT:` 行时，只要文中出现 `yet` 或 `later` 这两个词就被当成「等下一轮」的进度汇报，真结论因此被降成「没有结论」并多催一次。例如 `CHANGES_REQUESTED: the retry path has yet to be covered` 和 `APPROVED. The nits can be handled later.`。现在这两个词单独出现不再算；这两句分别判为需修改和通过。
- 结论行把否决写成 `VERDICT: CHANGES REQUESTED`（空格）或 `VERDICT: CHANGES-REQUESTED`（连字符）时不被识别：单独出现判成「没有结论」，后面再跟一行 `VERDICT: APPROVED` 则判成通过。现在这两种写法紧跟在 `VERDICT:` 后面时按否决行处理，后一种情况判为「没有结论」并催一次。
- 重复结算问宿主时，宿主回答「没有在跑」但队列里还排着一轮（`queueLength` 大于 0，催出来的那一轮还没开始）时，以前被当成「催出来的那一轮一个字没写就结束了」，卡片直接进「需人工」关口；排队的那一轮随后给出的结论因为卡片已不在「审查中」被丢掉。现在队列不空和「还在跑」一样处理：什么都不写，等那一轮结束再判。派发启动和定时对账早就是这样认的，这里口径统一。
- 重复结算问宿主期间先收到「审查被停止」（`chat.run.stopped`），再收到同一轮又报一次「完成」时，后一条会把停止冲掉，时间线写成「审查两次都没有给出结论」。现在这段时间里记下的结束通知只升级不降级：停止不会被后来的「完成」覆盖，仍写「审查被停止，没有给出结论」；停止之后又报失败，以失败为准。

### Changed
- 审查结论解析里 `yet` / `later` 的保留范围：`not yet` 照旧；同一句里有否定词（`not`、`n't`、`no`、`cannot`）和 `yet`，或者有 `will` / `I'll` 和 `later`（先后都算），仍算「等下一轮」。所以 `This is not APPROVED yet.`、`I will give the verdict later, likely APPROVED.` 仍是「没有结论」；如果把这两个词整个删掉，这两句会被读成通过。含 `not yet` 的回复（如 `CHANGES_REQUESTED: …(not yet covered).`）也仍是「没有结论」，会被催一次。中文词表没有改。
- `evidence` 新增一个键 `reviewInconclusiveTurn`（字符串，默认空；旧卡片没有这个键，按空处理）：本轮催促是针对哪一条审查回复发出的。每次派发审查和派发构建时清空，结算后保留。界面不显示它。

### Not changed
- 没有结论的卡片（`gateKind` 为 `review_inconclusive`）在验收通过时，看板上的状态药丸仍显示「构建完毕 · 测试通过」，容易被读成「可以合」；这次没有改界面，另行开单。催促仍是每轮审查最多一次，催促的文字、「需人工」关口、不唤醒总管都没有改。
- 不带 `VERDICT:` 的 `changes requested`（空格或连字符）仍只是普通文字，`No changes requested. APPROVED.` 仍判通过；一行里同时写两种结论的判断、以及没有结论行时认的否决字样，仍只认带下划线的 `CHANGES_REQUESTED`。没有新增 RPC、MCP 工具和数据库列，没有迁移。

## [0.9.51] - 2026-11-25

### Fixed
- 「运行记录」页在窄屏（宽度 980px 及以下）上，总管、构建、审查三组会话挤在一个 168px 高的列表里，要找「审查」的会话得先往下滑（390px 宽、总管 3 个 + 构建 5 个时要滑过约 310px，列表可视高 167px）。现在列表顶部有一条分类切换条：「全部」「总管」「构建」「审查」，每项带该类的会话数（如「构建 5」），点一下列表就只剩这一类；选「全部」时仍按 总管 → 构建 → 审查 分三组显示。

### Changed
- 分类切换条在列表上方、不在滚动区里，窄屏下列表滚到底它也不会被滚走；列表本身照旧可以滚动。没有会话的分类仍显示、计数为 0、不可点。只选一类时不再显示该类的分组标题（切换条已经写明了）。刷新后当前分类没有会话了，列表回到「全部」。切换条复用页面已有的分段控件样式（`.ot-seg` / `.ot-seg-btn`），窄屏下每个按钮高 40px。

### Not changed
- 切换分类只过滤左侧列表：右侧正在看的会话不跟着换，即使它已经被过滤掉，也一直显示到再点另一个会话为止；切换分类不重新加载数据。原有的 `data-testid`（`session-trace-view`、`btn-trace-back`、`btn-trace-refresh`、`trace-session-<会话号>`、`trace-timeline`）和右侧的时间线筛选（全部 / 回复 / 工具调用 / 推理 / 仅异常）都没有改。看板手机端的列签（`.ot-lane-tabs`）、思考框和运行状态条没有改。服务端、契约的模型 / RPC / 工具、数据库和宿主 Hermes 都没有改；没有迁移。

## [0.9.50] - 2026-11-25

### Fixed
- 总管回复时，流式思考框里的内容看起来像重复了两遍。原因是宿主发来的两种事件被当成了同一种：`reasoning.delta` 是模型的思考，`thinking.delta` 是这一轮的状态行（例如 `(◕‿◕) pondering...`，每一步模型调用前发一次）。以前两种都追加进思考文本，状态行就夹在思考的开头和段落之间。现在思考框只显示 `reasoning.delta`。
- 状态行改为显示在思考框下方已有的运行状态条里（原来显示「大总管正在响应...」/「正在推理与拆解方案...」的那一行）。只显示最新的一条，不累加；思考内容、回复正文或工具调用一到就撤下，状态条回到原来的文案。有工具在跑时仍显示「正在调用工具 …」。

### Changed
- 流式事件的处理从 `src/client/App.jsx` 移到 `src/client/stream-events.js`（`applyStreamEvent`），除上面两条外逐行未改，为的是能直接用事件序列测试。

### Not changed
- 思考框本身（位置、字号、颜色、折叠交互、字数与用时）没有改；没有新增第二个思考框或新的状态区域。聊天区顶部的运行状态行（「正在深度思考与拆解方案…」等）没有改。
- 空的 `thinking.delta`（宿主用来撤下状态行）和以前一样被忽略。断线重连时宿主回放的事件走同一套处理。
- 已保存的消息、契约（`contracts/plugin.json` 的模型、RPC、工具）、数据库和服务端都没有改；没有迁移。宿主 Hermes 没有改。

## [0.9.49] - 2026-11-25

### Fixed
- 卡片在「审查中」时被派「全新重试」，会先把工作树和任务分支删掉，然后才被状态机拒绝，卡片停在原阶段但 `worktreePath` / `branch` 指向已不存在的目录，diff 与快照失去来源。现在派发构建时先问状态机，再做任何停放、删除、清空；被拒时抛原来的错误（`Transition START_BUILD is not allowed from phase "reviewing"`），阶段、工作树、分支、快照、diff、会话都保持原值。
- 同一情况下并发槽位已满时，「审查中」的卡片会绕过状态机被直接放进排队队列。现在同样先问状态机，被拒就不排队。状态机允许开工的阶段（待办、排队、待确认、待合并、失败、已完成、已关闭）排队行为不变。
- 写锁超过 10 分钟被别的操作接管后，原来挂起的那个操作回来时仍会写卡片（实测：审查派发挂起、卡片被标记完成后，又被写回「审查中」；构建派发挂在探测引擎或建工作树时，卡片被标记完成后又被写成「构建中」并清掉审查结论）。现在持锁操作在每一次离开本进程的等待（宿主调用、git、文件系统）之后、紧接着的写卡片之前，先确认锁还是自己的；不是就不写，只在时间线记一行 `本轮结果已丢弃：这张卡在等待期间被另一个写操作接管（…）`，并返回卡片的真实状态。覆盖派发构建（探测会话、探测引擎、排队、全新重试删旧工作树、建工作树、启动运行）、派发审查、合并、停止（含清理工作树之后）、关闭、删除，以及标记完成 / 关闭后的工作树清理。
- 被接管时已经做完、撤不回的动作不改卡片，改为在那一行时间线里写明：合并已在 git 里完成的写提交号；工作树或分支已删除的写「已删除但未记入卡片」和路径；新建了工作树的写「已建好但未记入卡片」和路径。卡片上的 `worktreePath` 可能因此暂时指向已不存在的目录：重试合并会拒绝，下次派发构建会重新创建。
- 被接管的合并会让卡片停在「合并中」而没有合并在跑：用不带清理的停止放回待合并关口。
- 总管工具 `run_build` / `run_review` / `cancel_build` / `complete_todo` 在卡片于等待期间被删除时报 `TypeError`（看起来像工具故障）。现在回答「卡片已不存在，本次…已丢弃」，`data` 为 `{ id, discarded: true }`。
- 删除卡片的操作被接管后仍会把卡片删掉。现在不删，时间线记一行。
- 关闭卡片时如果还有排队的指令，宿主报告那一轮结束（或被停止）后，这条指令会被送达并重新开工：卡片回到「构建中」，刚清理掉的工作树被重新建出来，执行者又跑一轮。已标记完成的卡片同样会被重开。现在结算不再向已完成、已关闭的卡片送达排队的指令；关闭和停止在写完卡片后立刻清空队列，时间线记 `排队的 N 条指令没有送达，已移出队列（任务已结束 / 任务已停止）` 并附指令原文，不再等下一轮巡检。
- 构建或审查结算在等待期间（读会话记录、查失败原因、取快照、跑验收命令）卡片被停止、关闭、标记完成或重新派发时，结算回来会把卡片写回「待合并」或「失败」。结算不拿写锁（否则验收命令跑着的时候不能停止和关闭），现在改为在每次长等待之后核对卡片：卡片已不存在、阶段变了、会话或运行号变了、或此刻有别的写操作持锁，就丢弃本次结算并记同一行时间线。
- 合并进行中调用停止并清理（`cancel_build` 带 `discard`）会删掉合并正在用的工作树和分支。现在拒绝并提示「任务正在合并，完成后再操作」，且在停任何会话之前就拒绝。本进程里有合并在跑时，不带清理的停止也拒绝（停会话拦不住 git 合并）；卡在「合并中」但没有合并在跑的卡片（如重启后）仍可用不带清理的停止放回待合并关口。
- 合并进行中关闭卡片，报的是状态机英文错误。现在提示「任务正在合并，完成后再操作」。
- 停止不再清掉正在进行的合并的活动记录。
- `retry_merge` 的时间线一律记成用户操作，总管调用时也是。现在总管经 MCP 工具调用记为总管，看板上操作记为用户。
- `retry_merge` 判断工作树是否还在时不区分文件和目录。现在路径不存在或不是目录都拒绝。
- 验收命令（项目的「测试命令」）之前跑在 Studio 进程 `PATH` 上排第一的 `node` 上，和项目开发用的版本可以不是同一个：同一份代码开发方跑是通过的，卡片却被判失败、总管合并不了。现在按任务工作树根目录的 `.node-version` 选 `node`：先在 `PATH` 上逐个核对版本，再看 Homebrew 的 `node@<主版本>` 与 nvm / Volta / fnm / asdf / mise 的常见安装目录，用第一个符合的。`PATH` 上排在前面但版本不符、或者根本启动不了的 `node` 会被跳过。
- 声明的版本在机器上找不到时，验收直接判失败（`rc=127`），不执行命令，也不改用别的版本。`testSummary` 写明期望与实际，例如 `Failed (rc=127, 0.0s, node 未找到) | 期望 node v22.x（.node-version），当前 PATH 里找到的是 v26.12.1（/opt/homebrew/bin/node）；常见安装目录里也没有 v22.x，未执行验收命令`。`.node-version` 是空的或写的不是版本号（如 `lts/*`、`>=22`）时同样判失败并说明；文件在但读不了（是个目录、没有读权限、是断开的链接）也判失败，写 `.node-version 存在但无法读取（EISDIR）`，不会当成「没有声明」。
- 查找 node 的总时间不超过 15 秒（单个 node 最多等 5 秒）。`PATH` 上有多个卡住不响应的 node 时，验收以 `rc=127` 结束并写明 `解析超时`，卡片不会一直停在构建中。
- 验收失败后卡片上不再只有最后一行输出：失败的用例名写进 `evidence.testFailures`（去重，最多 8 条），`evidence.testFailureCount` 记总条数，`testSummary` 里带条数，例如 `失败用例 2 条`；超过 8 条时写 `失败用例 11 条（列出前 8 条，另有 3 条）`。识别 TAP 的 `not ok …`（带 `# SKIP` / `# TODO` 的不算）和 spec 报告器的 `✖ …`。用例名取自完整输出，不受 24 KB 截断影响。
- 审查没写结论会被当成「打回」。实际发生过：审查方做完静态审查、测试还在跑，留下一句「等它跑完后我再补跑全量……然后给结论」就结束了回合，平台当场把卡片记成 `changes_requested`，总管据此准备安排返工，而审查方一次否决都没下过。现在审查结论多了一种 `inconclusive`（没有结论）：最后一条回复没有 `VERDICT:` 行、也没有 `CHANGES_REQUESTED` / `APPROVED` 字样时，或者是「稍后」「等……再」「还在跑」「will continue」这类等下一轮的进度汇报时（即使文中提到了这两个词），以及回复为空时，一律记为没有结论，不再记成打回。回复里只有一处结论行（`VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`）时判法不变；有多处时见下一条。
- 审查回复里同时出现两种结论行时的判法变了。以前只要有一处 `VERDICT: CHANGES_REQUESTED` 就记成打回，不管它在哪；实际发生过：一份结论为通过的审查在正文里引用了这两种写法来说明规则，最后一行是 `VERDICT: APPROVED`，卡片却被记成打回。现在的判法：最后一处是 `VERDICT: CHANGES_REQUESTED` 时记为打回；最后一处是 `VERDICT: APPROVED`、而回复里别处还有 `VERDICT: CHANGES_REQUESTED` 行时，记为没有结论，走下面的催促流程，由审查方只写一行结论来确认。不按「最后一行」直接记为通过，是因为「必须修改。VERDICT: CHANGES_REQUESTED，修好后可以改成 VERDICT: APPROVED」这种回复的最后一行也是通过，记成通过会让总管把被否决的改动合并掉。代价是：引用了两种写法的通过审查要多走一个回合。最后一处所在的行同时写了两种结论（如 `VERDICT: APPROVED or CHANGES_REQUESTED`）时也记为没有结论。结论行写在代码块、引用块或加粗里同样算。
- 结论行里的全角冒号（`VERDICT：APPROVED`）以前不认，会落到按字样猜。现在与半角冒号同样处理。
- 没有结论时先自动催一次：在同一个审查会话里续跑，要求它本回合内给出结论并在最后一行写 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`。卡片保持「审查中」，时间线记 `审查未给出结论，已要求它收口（同一审查会话续跑，自动催促 1/1）`。每轮审查只催一次，次数记在 `evidence.reviewInconclusiveRetries`，每次派发审查或派发构建时归零。
- 催过之后仍没有结论：卡片停在待合并关口，交给用户（`gateOwner` 为 `human`，话题开了 AUTO 也一样），`gateKind` 为 `review_inconclusive`，时间线记 `审查两次都没有给出结论，需要人工判断或重派审查`。不再唤醒总管，也不会排队等它下一轮处理。审查被手动停止时不催，直接交给用户；催促发不出去时同样交给用户并写明原因。
- 审查运行失败（模型报错、会话异常结束）以前也记成「打回」，时间线写「独立审查结论：需修改」。现在单独记为 `review_failed`，`gateKind` 为 `review_failed`，交给用户，时间线记 `审查运行失败：<原因>（没有审查结论，需要人工判断或重派审查）`，不再唤醒总管安排返工。
- （#46）派发独立审查时，卡片要等宿主的启动调用返回后才写成「审查中」。审查会话如果在这之前就结束，宿主的结束通知到达时卡片还在「待合并」（首次审查时卡片上连审查会话号都没有），通知被忽略，卡片随后停在「审查中」、结论一直是 `pending`，只能等后台巡检发现会话已空闲才结算。现在先把卡片写成「审查中」并记下审查会话，再启动运行；启动调用期间到达的结束通知先记下，派发一结束立刻结算。启动失败时卡片回到原来的阶段、把关人、审查人、审查会话、上一轮结论和催促次数（`reviewInconclusiveRetries`），时间线记 `审查派发未成功，卡片保持原状：…`。
- （#46）配合上一条：卡片已是「审查中」但审查运行还没启动的那几秒里，后台巡检不再去探测和结算这张卡（那时审查会话空闲只是因为还没开始，结算会写出一条没有任何审查给过的「需修改」或上一轮的旧结论）。卡片上没有本轮审查运行号时，巡检一律不按会话记录结算。
- （#46）派发审查中途服务重启，或启动调用一直不返回，卡片会停在「审查中」而没有审查在跑。现在巡检发现「审查中」、没有本轮运行号、审查会话空闲（或宿主连续 2 分钟都说不清这个审查会话的状态，例如重启后宿主已不认识它；只探测到一次说不清不算）、且卡片已 2 分钟没有任何写入时，把它放回待合并关口：审查结论清空（`none`），上一轮的审查正文一并清空，由谁把关按构建完成后的同一规则判定（AUTO 话题但项目未开自动合并、验收未过、验收被跳过、或有未答问题时归用户，任一条即可；这一步不唤醒总管），原因写在卡片上，时间线记 `检测到未启动的审查（没有运行记录），已自动回到待合并关口，审查结论清空`，审查会话保留，重新派发审查即可。已知边界：宿主接受了启动却没返回运行号、且结束通知又丢失的审查，也会走这条路，需要重新派发一次审查。
- （#46）停止（`cancel_build`）用在已完成或已关闭的卡片上，会把卡片写回「待办」并清掉运行号，时间线还记「已停止当前运行」；带清理时会把已关闭卡片留着的工作树和分支删掉。现在拒绝并说明原因：`#N 已完成，没有可停止的运行，本次停止没有执行。需要再做请重新打开或重新派发。`（已关闭的卡片写「已关闭」），卡片、工作树和分支都不动。
- （#46）关闭已完成的卡片，报的是状态机英文错误 `Transition CLOSE is not allowed from phase "done"`。现在提示 `#N 已完成（已合并或已标记完成），不需要关闭，本次关闭没有执行。需要再做请重新打开。`
- （#46）排队指令的「任务已结束」阶段清单里有一个状态机不存在的 `cancelled`，上一条发布说明和 `docs/CONTRACTS.md` 也照着写了。已从清单和文档里删掉（包括 `docs/CONTRACTS.md` 的 `todo_queue` 表说明），清单现在只有已完成、已关闭两个阶段；行为没有变化（没有卡片会处在那个阶段）。

### Changed
- 审查结果为「没有结论」或「审查运行失败」时，话题里仍会出现一条进展提示，但不会启动总管。之前审查运行失败在开了 AUTO 的话题里会唤醒总管并按打回处理。
- 看板界面这次没有改：这两种新状态在卡片详情的审查结论处暂时显示为「未发起」，按钮与普通待合并卡片相同（可重新审查、退回修改或合并），具体原因以时间线为准。
- 停止（`cancelBuild`）、关闭（`closeTodo`）、重新打开（`reopenTodo`）加入同卡写锁。同卡已有写操作在进行时，这三个操作直接被拒并说明原因（`#N 正在执行「X」，本次停止没有执行，请稍后再试`，关闭、重新打开各用自己的那一句），不排队等待，卡片不变。影响：构建或审查正在派发的那几秒里点停止会被拒，派发结束后再点即可；派发在宿主里挂住时，最长 10 分钟后锁失效才能停止。
- 构建完成后与重试合并后「由谁把关」的判断合并为同一个函数，结果与之前一致。`assertMergeAllowed` 没有改：验收被跳过的卡片用户仍可手动合并，总管仍合不了。
- `testSummary` 带上实际使用的 node 版本：`Passed (rc=0, 26.0s, node v22.23.2)`、`Failed (rc=1, 27.2s, node v22.23.2) | 失败用例 2 条 | …`、`Timed out after 180s (rc=124, node v22.23.2)`。
- 没有 `.node-version` 的项目照旧按 `PATH` 执行，结论里标出 `node v26.12.1 未声明`（`PATH` 上没有可用的 node 时是 `node 未声明`）。
- 本仓新增 `.node-version`（`22.23`），作为测试用运行时的唯一声明；CI 改为读这个文件（原来写死 24）。`package.json` 的 `engines.node`（`>=22.13.0`）没有改，它是运行 Studio 的进程的下限。声明写到次版本，是因为只写 `22` 会把低于下限的 `v22.5.0` 也算作符合；有一条测试核对声明不低于下限。
- 选中的 node 一律用绝对路径；`PATH` 里的相对目录先按任务工作树解析。
- 验收命令本身启动不了时，`testSummary` 也带 node 版本并限制在 600 字符内：`Test command failed to spawn (node v22.23.2): …`。
- 每次派发构建、空转、跳过验收时，`testFailures` 与 `testFailureCount` 和 `testRc` 一起清空；验收通过时写空数组。
- （#46）合并前的条件检查做两次：拿写锁之前一次（不满足就不占锁、不在时间线记「正在执行」），拿到锁之后按库里最新的卡片再查一次，合并用的阶段、分支和工作树都取自第二次读到的卡片。两次之间卡片离开待合并关口、审查结论被改掉或卡片被删，都会被拒绝且不写卡片。当前版本这两处之间没有等待，别的操作插不进来；第二次检查是为了以后在中间加等待时仍然成立。
- （#46）派发审查期间（启动调用返回之前的几秒）卡片已经显示「审查中」、结论为 `pending`、运行号为空。这段时间里标记完成和派发构建被派发持有的写锁拒绝（`TODO_BUSY`，`#N 正在执行「审查派发」，…`），和以前一样；只有锁过期被接管、卡片仍停在「审查中」时，状态机才会以 `COMPLETE` / `START_BUILD` 没有出口为由拒绝。

### Not changed
- 没有新增 RPC、MCP 工具和数据库列，没有迁移；MCP 工具数仍为 32。界面没有改。0.9.49 的 `evidence` 新增三个键：审查结论这部分的 `reviewInconclusiveRetries`（旧卡片没有这个键，按 0 处理），以及验收这部分的 `testFailures`、`testFailureCount`（见本段最后一条）；`reviewVerdict` 新增取值 `inconclusive`、`review_failed`，`gateKind` 新增取值 `review_inconclusive`、`review_failed`。旧卡片上已经存下的结论不会被改写。
- 指令入口（补充指令 / 退回修改 / 答复问题 / 确认方案）仍不拿这把锁，最后启动构建时由 `startBuild` 拿。
- 被接管的派发如果已经在宿主里启动了运行，不会去停它（那个会话可能已归新的持锁操作使用）；它结束时卡片不在对应阶段，结算不会写入。
- `v0.9.42` 与 `audit#11` 的时间预算断言没有放宽。node 26 全量并行下偶发超预算是另一个问题，不在这次范围内。
- 验收运行时与失败用例名这部分没有新增数据库列，没有迁移；旧卡片读出来 `testFailures` 为 `[]`、`testFailureCount` 为 `0`（这两个是上面「验收失败后…」一条新增的 `evidence` 键）。

## [0.9.48] - 2026-11-25

### Added
- 合并失败后可以重试：新增 RPC `retry-merge` 与 MCP 工具 `retry_merge`（参数 `todo_id`）。卡片因合并失败停在「失败」时，调用后回到待合并关口，审查结论、验收结果、分支、工作树原样保留，不用重新构建和重新审查。它只把卡片放回关口，不发起合并；之后的合并照常过全部检查（总管合并仍要求审查通过、验收通过、话题 AUTO、项目允许自动合并）。
- 只接受合并类失败：卡片须为「失败」、`lastError` 以「合并失败」开头、任务分支与工作树目录都还在。构建失败、空转失败（`本轮没有产生任何提交…` / `有改动未提交，且 HEAD 未前进…` / `本轮被停止，没有产出…`）一律拒绝；工作树已被清掉时也拒绝，并且不会自动重建（重建会丢改动），需要重新构建。被拒时抛中文错误、时间线写 `重试合并没有执行：<原因>`，卡片阶段不变。
- 重试后由谁把关按当时的设置重算：部署卡、话题未开 AUTO、项目未允许自动合并、配了验收命令但未通过、验收被跳过（`evidence.gateSkipped`）、有未答复问题，任一成立即由用户把关，否则交给总管。
- 状态机 `failed` 新增出口 `RETRY_MERGE → review`。
- 同一张卡的写操作互斥：派发构建、派发审查、合并、重试合并、标记完成、删除共用一把进程内锁（记录持有者、时间和操作名）。同卡已有操作在进行时，后来的直接被拒并说明原因（`#N 正在执行「X」，本次…没有发出`），不排队等待；派发构建、派发审查、合并、重试被拒时还会在时间线记一行。锁在操作结束时释放，超过 10 分钟自动失效；不落库，进程重启后自然清空。

### Fixed
- 合并进行中的卡片本来就不能标记完成，但报的是状态机的英文错误（`Transition COMPLETE is not allowed from phase "merging"`）。现在直接拒绝并提示「任务正在合并，完成后再操作」，同时补上 `mergingTodos` 守卫（之前只靠阶段判断）。
- 合并进行中对卡片点「全新重试」，会先删掉工作树、清空分支再报错。现在在动任何东西之前就拒绝。
- 审查正在派发时，同一张卡还能被标记完成或再派发一次审查（会起两个审查会话）。现在后来的操作被拒。

### Changed
- 合并失败的 `lastError` 与时间线改为 `合并失败（冲突文件：a、b；处理后可调用 retry_merge 回到合并关口，审查结论保留）：<git 原始错误>`。仍以「合并失败」开头；冲突文件清单取自 git 的冲突输出，取不到时（如主仓有未提交改动）省略这一段。
- MCP 工具数 31 → 32；总管提示词里写的工具数同步为 32。

### Not changed
- 合并失败本来就不会清审查结论、分支、工作树、快照与 diff（只写阶段、把关人和错误），这次只补了回归测试锁住，没有改这段行为。
- `assertMergeAllowed` 没有改：验收被跳过（`testRc: -1`）的卡片总管仍然合不了，用户仍可手动合并。
- 指令入口（补充指令 / 退回修改 / 答复问题 / 确认方案）的去重、排队与并发拒绝规则没有改；它们自己不拿这把锁，最后启动构建时由 `startBuild` 拿。
- 没有新增数据库列和 `evidence` 键，没有迁移。界面没有改，「重试合并」按钮另行开单。

## [0.9.47] - 2026-11-25

### Fixed
- 构建会话什么都没做就正常结束，卡片仍显示「构建完成」并进入待合并关口，验收命令跑的是原来的代码所以总是通过。现在每轮构建派发时记下工作树的 HEAD 和磁盘文件的 tree（`evidence.roundBaseSha` / `evidence.roundBaseTree`，含未提交与未跟踪文件），本轮结束时在跑验收命令之前比较：两样都没变就是空转，不跑验收命令，不进待合并关口。
- 空转后的处理：Agent 开了自动切换、本卡还没因空转重跑过、且有可用备选配置时，换到备选配置开新会话重跑一次（`evidence.idleRetries` 记 1，时间线写 `… 构建会话空转（无产出）：…；已自动切换至 … 重跑一次。`，`fallbackHistory[].category` 为 `idle_build`）。原配置的 1 小时冷却只在真的切换时才记：没有备选可换时不记，避免 Agent 唯一的配置因为一次空转被冷却。重跑没能启动时卡片失败，`lastError` 追加 `；自动重跑未能启动：<原因>`，`idleRetries` 不计这一次。否则卡片失败，`lastError` 写 `本轮没有产生任何提交（HEAD 仍为 <sha>），任务未推进`；工作树里有未提交改动但和开工时一样时写 `有改动未提交，且 HEAD 未前进（<sha>）`。
- 空转失败的卡片证据写 `gateSkipped: 'no-new-commit'`，`testRc` 置为 -1（未运行），之前轮次留下的通过结果不再保留。
- 被停止的轮次（宿主事件 `chat.run.stopped`，包括停止、关闭、删除卡片时插件自己发起的停止）没有产出时不会自动重跑：卡片失败，`lastError` 写 `本轮被停止，没有产出（HEAD 仍为 <sha>）`，不记冷却、不写 `fallbackHistory`、不唤醒总管。被停止但工作树有变化的轮次照旧结算。
- 每次派发构建时把上一轮的验收结果清掉（`testRc: -1`、`testSummary: ''`），构建进行中卡片不再显示上一轮的通过结果。
- 结算时取不到工作树快照（工作树已删，或快照出错）不再去跑验收命令：证据写 `gateSkipped: 'no-snapshot'`、`testRc: -1`，卡片进入待合并关口并交给用户处理，时间线写 `取不到工作树快照，跳过产出校验`。

### Release
- 新增 `THIRD-PARTY-NOTICES.md`：两个 `dist/` bundle 把 65 个第三方包编进去了，随插件分发就是再分发这些包。这份文件由 `npm run notices:write` 从 esbuild metafile（`dist/bundled-packages.json`）和每个包自带的许可文件生成，列出包名、版本、声明的许可与完整许可原文；`npm test` 会在文件和 bundle 不一致、或有包声明了限制再分发的许可时失败。
- 安装文档改成以 GitHub 仓库链接为主路径：Studio 取仓库最新提交的完整 SHA，按该提交装包。`README.md` 与 `INSTALL.md`（简体中文）同步了这条链路、升级与回滚、以及公开仓才会出现的几类报错。
- `README.md` / `SECURITY.md` 里关于凭据的表述改成实际边界：模型与引擎凭据从不经过插件；配额面板与仓库导入这两项可选功能会存各自的凭据（含复用本机 CLI 已有的凭据），只在配置后生效、只发给用户配置的那个端点。原来的「零凭据存储」绝对表述不成立，已撤下。
- 内部项目名的 denylist 从 `tests/contracts.test.mjs` 移到未跟踪的 `.private-denylist.json`，源码里只留「形状」规则（用户目录、私有网段）。原来把真实项目名写进受版本控制的测试，公开后等于把要保护的名字一起公开。

### Not changed
- 本轮有新提交（空提交也算），或磁盘文件相对开工时有变化（未提交也算），仍按原流程跑验收命令并进入待合并关口。
- 方案规划轮不做空转判定，也不写时间线。取不到快照或开工基线的轮次（包括升级前已派发、还在跑的卡）不做空转判定，并在时间线写一行 `…跳过产出校验`。部署类卡片同样要求产出，零产出按空转处理。
- 运行失败（`chat.run.failed`）的处理与故障分类规则没有改；`idle_build` 只由空转判定产生，`classifyModelFailure` 不会返回它。
- 没有新增或修改 RPC、工具、事件与数据库列；`evidence` 多了 `roundBaseSha`、`roundBaseTree`、`gateSkipped`、`idleRetries` 四个可选键，旧卡片没有这些键时按「无基线」处理。界面没有改，失败原因显示在卡片现有的错误位置。

## [0.9.46] - 2026-11-25

### Fixed
- 构建运行中模型返回空响应时不会自动换模型：运行期故障切换一直在，但故障分类里没有「空响应」这一类，这类错误一律判成「运行异常」不切换。现在新增分类 `empty_output`（模型返回空响应），命中 `response.output is empty`、`empty after stream backfill`、`Invalid API response`（含 `(retry N/3)` 与 `after 3 retries`）、`no content`、`no visible content`、`empty response`、`empty output / message / completion`、`Reasoning-only response`、`无输出`、`空响应`。Agent 开了自动切换且有可用备选时，原地换到下一个配置续跑，卡片时间线写 `… 运行失败（模型返回空响应），已自动切换至 …`。大总管会话用的是同一个分类器，同样生效。
- 失败的构建卡片只写「执行会话异常结束」，看不出是模型问题还是代码问题。现在宿主的失败事件不带错误（或只带这句兜底文案）时，先读宿主会话记录里的错误字段（`lastError` / `last_error` / `error` / `errorMessage` / `error_message` / `failureReason` / `failure_reason`，最多等 3 秒）；没有再看本轮对话：最后一条指令之后没有任何助手文本，就按模型空响应处理（可切换）。两边都取不到时卡片仍为失败，`lastError` 写 `未能取到模型侧原始错误（会话 <id>，配置 <配置标签>，宿主事件 code=… stop_reason=…）`。
- 失败卡片的 `lastError` 与时间线 `构建失败：…` 现在都带原始错误摘要（最多 400 字）。判定为模型服务故障的写成 `模型服务异常（<分类>）：<原文摘要>`；合并冲突、测试门禁、用户中止等非模型失败保持原文，不加前缀。
- 模型故障但没有可切换的配置（没配备选，或备选都在 1 小时冷却中）时，卡片照常失败，时间线多一行 `模型 <配置标签> 服务异常（<分类>），但没有可用备选配置…`，提示去 Agent 设置里添加备选。

### Not changed
- 单独的「执行会话异常结束」/「审查会话异常结束」不会触发切换；`merge conflict`、`uncommitted changes`、`test gate`、`rc=1`、`worktree`、`abort`、`stopped by user` 仍然先于所有模型故障分类判定，同一条错误里即使带空响应字样也不切换。
- 宿主事件标了 `interrupted` 且不带错误的失败不按空响应处理，卡片写 `运行被中断，宿主没有给出错误信息…`。
- 审查会话失败与大总管会话失败在事件不带错误时的文案（`审查会话异常结束` / `总管会话异常中断`）没有改。
- 没有新增或修改任何 RPC、工具、事件与存储结构；`fallbackHistory[].category` 多了一个取值 `empty_output`。
## [0.9.45] - 2026-11-25

### Fixed
- 同时有两个总管在跑时，不带 `topic_id` 建的卡会挂到别人的话题：0.9.44 的「活跃总管运行推断」取的是最近开始的那个总管，而谁开始得晚与谁在调用建卡工具无关。现在在它之前加一步 `caller-tool`：宿主在执行工具前会先发 `chat.tool.started`，插件记下每个总管会话最近开始的工具（`chiefToolCalls`，只记话题的 `chiefSessionId`，构建 / 审查 / 普通对话会话不记），建卡时取 120 秒内刚开始调用建卡工具（工具名匹配 `create_utodo` / `create_todo`，带不带 `mcp__ekko_todo__` 前缀都算）的那个总管会话所在话题，多个时取最近一次调用。卡片时间线写 `建单未指定话题：按调用中的工具定位到话题「X」`，`data.topicResolvedBy` 为 `caller-tool`。
- 「活跃总管运行推断」保留为宿主没发工具事件时的降级，但多个总管在跑时不再把结果写成结论：时间线改为 `按活跃总管运行推断，挂到话题「X」（N 个总管在跑，无法确定调用方，取最近开始的）`，`create_todo` 的返回文字同时写明 `当前有 N 个总管会话在运行，无法确定建卡归属，请显式传 topic_id`，不再只写系统消息。

### Not changed
- 显式 `topic_id`、`identity.sessionId` 命中、跨项目按最近更新兜底、无人值守话题四档的语义与顺序不变；只有一个总管在跑时结果与 0.9.44 相同。
- 没有持久化结构变化：`chiefToolCalls` 只在内存里，建卡工具调用结束、该会话的运行开始或结束、或超过 120 秒即失效。

## [0.9.44] - 2026-11-25

### Fixed
- 大总管用 `create_todo` 建卡不带 `topic_id` 时，卡片从未落到调用方话题：宿主的工具调用不带 `identity.sessionId`，项目兜底又只看同项目话题，结果挂进没有总管会话的话题，进展通知没人看。现在在这两步之间加一步「活跃总管运行推断」：插件从宿主 `chat.run.started` 事件记下哪些总管会话正在跑（只记话题的 `chiefSessionId`，构建 / 审查 / 普通对话会话不记；`run.completed` / `run.failed` / `run.stopped` 时移除），建卡时取本账号、未归档、仍在运行的话题里最近开始的那个。同时有多个总管在跑时取最近开始的，并在卡片时间线写一行 `按活跃总管运行推断…`。宿主将来若带上 `identity.sessionId`，它仍然优先。
- 宿主没发 `run.started`（或插件在那之后重载）时：该总管会话的任一工具事件也会把它记为运行中；一个事件都没有时退到下一步「最近更新的总管话题」，不会静默落到无人值守话题。
- 兜底一步原来只在同项目话题里按侧栏顺序（置顶优先）找有总管会话的。现在在本账号全部未归档话题里按最近更新时间取第一个，置顶不再影响；话题所属项目与建卡项目不同时，卡片时间线写 `卡片挂在话题「X」（属于项目 Y），与建卡项目 Z 不同`。
- `create_todo` 的返回增加 `data.topicId` 与 `data.topicResolvedBy`（`explicit` / `caller-session` / `active-run` / `chief-topic` / `unattended`）。落到无人值守话题时返回文字里直接写明并要求显式传 `topic_id`，不再只写话题里的系统消息。
- 新建话题不再默认挂到项目列表的第一个项目，也不再继承当前打开话题的项目：只有在某个项目页里新建才归属该项目，其余为「不归属项目（可跨项目使用）」。

### Added
- 话题菜单新增「改挂项目」：把话题改挂到另一个项目，或选「不归属项目（可跨项目使用）」清空。只改话题的项目归属，卡片、对话、总管会话不动；`update-topic` 收到不存在的项目 ID 会拒绝（`项目不存在：<id>`）。

### Not changed
- 已有话题的项目归属一条都没有迁移；现有话题需要的话请在话题菜单里逐个改挂。
- `identity.sessionId` 命中、显式 `topic_id`、无人值守话题的系统消息与 `:unattended:` / `:undelivered:` 唤醒记录都保持原样。

## [0.9.43] - 2026-11-25

### Added
- 大总管上下文胶囊：输入框工具栏右侧、发送键左边显示 `上下文 52.8万 / 100万 (52.8%)`；对话栏窄于 560 px（1440 宽下与看板同屏时约 340 px）只显示 `53%`，手机上胶囊和压缩按钮合成一个 40 px 按钮。用量只取宿主自动压缩所比较的那个数（`resumed` / `usage.updated` / `compression.completed` / `run.completed` 的 `contextTokens`）；`/context` 的 `totalTokens`（input + output，同一会话实测 77.7万，而阈值检查是 52.8万）只用于探测命令通道和超时自检，不改胶囊。窗口取自宿主 `GET /api/studio/sessions/context-length`，阈值取自宿主配置 `GET /api/hermes/config?section=compression` 的 `compression.threshold`（只读这一段；该段没有可用值时按宿主读法取 0.5，读不到时用 0.65）；用量到自动压缩触发点（窗口 × 阈值）的 90 % 变警示色，悬停提示写明触发点。宿主压缩时显示「压缩中 Ns」，从 `compression.started` 记下的时间起算；断线错过 `compression.completed` 时，重连的 `resumed` 或 120 秒上限会结束这个状态。
- 手动压缩：点胶囊里的压缩按钮先弹确认（会丢历史细节、约 10–30 秒、只压缩大总管会话），再走宿主自己的 `/compress`。插件不实现压缩：页面用已有的实时会话句柄 `connect(...).run('/compress')` 发命令，读宿主回的 `session.command` 与 `compression.started` / `compression.completed`。每次压缩前先发 `/context`：确认命令通道没被拦截（宿主把它交给模型时立即停止那一轮、记为不支持并禁用按钮，直到换话题；8 秒没回包只算这一次失败，写 `压缩超时，上下文未变，可重试`，按钮保持可用，服务端之后的通道判断照常生效），同时取得超时自检用的基线。
- 压缩期间锁住话题：新 RPC `begin-topic-compress` 返回 `lockId`， 在大总管运行、启动中或已在压缩时拒绝并给中文原因（与宿主 `isWorking || isCompressing` 闸门一致）；持锁期间发消息（含插队）入排队、唤醒入排队且不置 `isRunning`、排队不投递、「立即执行」被拒，锁结束后由对账循环投递。锁只在内存，135 秒自动失效，插件重载即释放；只有带同一个 `lockId` 的 `record-topic-command` 能释放它，探测失败（还没上锁）和过期标签页的记录不会放掉别人的锁。页面在等结果时离开这个会话（切话题），命令记为「实时通道已断开，压缩结果未知」：不写系统消息、不释放锁（宿主可能还在压，锁等 135 秒自然过期），绝不写「压缩失败，上下文未变」；同一会话的订阅重建（例如切到设置页再回来）继续等宿主回包。`/compress` 被宿主当普通消息交给模型时与 `/context` 一样立即停止那一轮并禁用按钮。页面最多等 120 秒，没等到终态就再发 `/context`，降到基线 80 % 以下算成功；结果统一由 `record-topic-command` 写成系统消息并释放锁：`上下文已压缩：174273 → 8191 tokens`、`上下文没有可压缩的内容，宿主未改动`、`压缩失败，上下文未变，可重试：…`、`压缩超时，上下文未变，可重试`。
- 斜杠命令面板：输入框以 `/`（或全角 `／`）开头时弹出，迁移 `/status` `/context` `/usage` `/compress` `/compact` `/clear` `/title` `/abort` `/queue` `/steer`，命令都由宿主执行，结果写进对话。`/compress` `/compact` `/clear` 先确认。`/clear` 发的就是 `/clear`，宿主默认只清空当前显示、数据库历史保留（宿主回 `Cleared the current display. History in the database was not deleted.`），面板写「清空当前显示（宿主历史保留）」，弹窗写「只清空宿主当前显示的对话；数据库历史保留，大总管仍记得之前的对话」；`/clear --history` 被拦下，不在大总管会话开放。`/abort` `/queue` `/steer` 只在运行中可用。`/plan` `/moa` `/goal` `/subgoal` `/skill` `/bundles` `/learn` `/yolo` 等 Hermes Agent 专有命令不在面板里，手打会被拦下并提示「大总管会话未开放」。面板与 0.9.41 的 @ 选 Agent 不会同时打开（键入和点工具栏 @ 两条路径都会先关掉另一个）；面板没有匹配时回车什么都不做（不误发草稿）；选命令时按光标当前所在的 `/` 片段替换，光标已移出该片段就什么都不插入。
- 新 RPC `get-topic-context`（只读：窗口、模型、命令通道 `ready/unsupported/unknown`、锁时间），快照视图字段 `topics[].compressingSince`。契约与 `docs/CONTRACTS.md` 已登记，实测记录见 `docs/RENDER-EVIDENCE-0.9.43.md`。

### Fixed
- 在大总管输入框直接打 `/compress`、`/status` 等宿主命令时，消息走 `send-topic-message` → `sessions.run`（HTTP）。宿主对命令既不回 `run.started` 也不回 `run.queued`，HTTP 会一直等到超时，期间话题挂着「运行中」、对话里多一个空回合。现在这类文本一律走实时会话命令通道，不再当成聊天回合发送。

### Not changed
- 自动压缩仍由宿主每轮阈值检查触发，插件没有改它；卡片任务（开发 / 审查会话）不提供手动压缩，本功能只作用于大总管会话 `chiefSessionId`。
- 没有压缩历史记录页面。
- 没有在用户的大总管会话上实际执行 `/compress`（会改写真实历史）；压缩链路在临时 Hermes 会话上实测，空会话返回 `compressed: false`，有内容时的 tokens 前后值未实测。

## [0.9.42] - 2026-11-25

### Fixed
- Sending a message could hang until it timed out. `send-topic-message` waited until the host had accepted the Chief run, and `message-todo` / the `message_todo` tool waited until the host had accepted the worker run. The host holds a run sent into a busy session for 120 seconds; the host log shows `message_todo` calls ended by the host's plugin RPC limit after 120 seconds. `send-topic-message` and `promote-topic-queue-item` now answer after at most 800ms and `message-todo` after at most 1500ms; the launch continues in the background. A launch that finishes inside that time answers as before.
- While the launch continues, your message shows `已收到，正在启动大总管…` under its bubble. If the launch then fails, the bubble gets the reason (`大总管没有收到：…`) and the running indicator stops. For a card, the timeline gets `补充指令已接受，正在后台启动（宿主尚未确认）`, and a failure is written to the card as before. The `message_todo` tool answers `accepted, still starting` and tells the caller not to send it again.
- A send repeated while the first delivery was still being handled was stored or executed a second time: a follow-up queued twice, or queued behind its own first delivery. The server now answers a repeat of the same `clientNonce` at once without storing or starting anything, checks the nonce again after the busy probe, and `topic_queue` holds a nonce once per topic.
- The same instruction sent to a card again while its run is being started is accepted once. A different instruction sent in that time is refused with `…还在启动中，这一条没有发出，请稍后再发`; before, it was dropped and the call reported success.
- A queued follow-up whose launch failed was put back in the queue and also left in the chat as a bubble. It is now only in the queue; when the last of 3 attempts fails it is only a bubble, with the reason on it. `立即执行` on a queued follow-up follows the same rule.
- `request-changes`, `answer-question` and `confirm-plan` still waited for the host to accept the worker run (2 s in a test with a host that takes 2 s). They now use the same 1500 ms budget as `message-todo` and answer `launchPending` with `todo.launch.pending:<todoId>` after it.
- Answering a card's question while the card was still starting returned success, recorded the answer and sent nothing. A start under way now refuses the answer (and any other instruction) with `…没有发出，请稍后再发`, written on the timeline; the answer is not recorded.
- An instruction to a worker whose session was still running a turn was sent into that session anyway, and when the host refused it as `already running` the card stayed `building` with no error while the text never reached the worker. The session is now probed first (at most 700 ms); a busy one gets the instruction in the new `todo_queue`, shown on the timeline as `已排队，本轮结束后自动送达`, and it is sent when the turn ends. An `already running` refusal is a failed delivery with a readable `lastError` and timeline line.
- Instructions queued for a busy worker were sent only when the card was still `building` and the turn had not failed. An answer at the confirm gate or changes requested at the review gate stayed in the queue and were sent after the next, newer instruction. They are now sent when the build session's turn ends, whatever the phase, and reconcile sends them when that event was lost. After a failed turn they are removed with `排队的 N 条指令没有送达，已移出队列（上一轮以失败结束）` on the timeline and in `lastError`, and never sent later.
- The same instruction sent again within 60 s after its run had started was dispatched a second time. It is now answered with the current card (`duplicate`) and nothing is sent or written.
- A launch that takes longer than 3 seconds writes a warning to the host log with the topic or card id and the time in milliseconds.
- After pressing send, your message appeared in the chat only when the server had finished starting the Chief (session check, engine probe, session creation, model setup, run start). The bubble is now drawn when send is pressed, marked `发送中…`, and the composer is cleared in the same step. Measured in a browser against a test host whose start-up takes 0.76-1.02s: click to visible bubble went from 759-1022ms to 3-6ms; the stored copy replaced it 12-22ms after the click.
- The server stored your message after probing the engines. `send-topic-message` now stores it and announces it (`board.updated`, reason `topic.message.accepted:<topicId>`) first, then probes and starts the Chief. A slow probe no longer delays the bubble.
- When the Chief could not be started, the reason was shown only in a toast and the banner at the top of the topic. The message is kept and now carries the reason under its bubble (`大总管没有收到：…`), also after a reload. When the failure arrives before the call answers (inside 800ms), the composer gets your text and files back, as before; when it arrives later, the text stays in the bubble only.
- The page waited up to 800ms before reading an update about your own message, because every `board.updated` went through the window that spaces out refreshes. Updates with reason `topic.message.accepted`, `topic.message.queued` or `topic.message.failed` are now read at once. Build output and activity ticks stay in the 800ms window.
- A send repeated by the automatic retry after a tunnel miss (edge 404/502/429) could be stored twice. Each send carries a `clientNonce`; the server stores and runs a nonce once per topic.

### Changed
- `topicMessageInput` has a new optional field `clientNonce` (1-64 characters from `A-Z a-z 0-9 _ . : -`). Stored messages and queued follow-ups return it as `clientNonce`; a message the Chief did not get returns `sendError`. Both are present only when set.
- Storage: `topic_messages` gets the columns `client_nonce` and `send_error`, `topic_queue` gets `client_nonce` (all `TEXT NOT NULL DEFAULT ''`), and unique indexes `idx_topic_msgs_nonce` and `idx_topic_queue_nonce` on `(topic_id, client_nonce)` for non-empty nonces. They are added on first start; existing rows keep `''` and need no migration step. Before `idx_topic_queue_nonce` is created, queued follow-ups that share a topic and a non-empty nonce are reduced to the earliest one. An older build can still open the database (it ignores the new columns).
- A topic in `stateSnapshot` has `launching: true` while a Chief turn is being started for it and `launchingMessageId` when that turn is for a user message; both are absent otherwise. The `message_todo` tool result has `data.accepted` (always true) and `data.starting` (true when the call answered before the host accepted the run).
- Storage: new table `todo_queue` (`id`, `todo_id`, `user_id`, `profile`, `kind`, `text`, `client_nonce`, `created_at`) with index `idx_todo_queue_todo`; created on first start, no migration.
- A host rejection of `sessions.run` is written to the host log with the session id and the time it took.
- Messages and queued follow-ups stored in the same millisecond are returned in the order they were stored (`ORDER BY created_at ASC, rowid ASC`).

### Not changed
- The assistant stream. It was not in the 800ms window: stream events are drawn on the next animation frame. Measured: first stream event to first character on screen 15ms on 0.9.38 and 34ms on this version, read once per frame (about 16ms), so the two values do not differ by more than the measurement step. End of stream, held reply and reconnect work as in 0.9.36.
- A message sent while the Chief is running is still a queued follow-up shown in the queue tray, not a bubble, until its turn starts. For such a send the server asks the host whether the run is still alive (up to 700ms) before it stores the follow-up; the bubble drawn by the page is visible during that time.
- When no topic is selected, the topic is created first and the bubble appears after that call.
- A message whose start failed stays in the topic with its reason. Sending the restored text again adds a new message; the failed one is not removed.
- `run_build` and the other card actions that start a run (start, retry, independent review) still wait for the host. The worker instructions `message-todo`, `request-changes`, answering a card question and `confirm-plan` use the 1500ms limit.
- The plugin cannot make the host accept a run into a busy session sooner. The call no longer waits for it; whether the instruction reached the worker is on the card timeline.
- Review, merge, quota, the phone top bar, the composer draft and the 0.9.40 sidebar are untouched. The `board.updated` event keeps its name, payload fields and audience.
## [0.9.41] - 2026-11-25

### Fixed
- Typing `@` in the Chief chat box only opened the Agent picker at the start of a line or after a space, so `你好@` or `看一下，@` did nothing. The picker now opens wherever `@` is typed: at the start of a line, after a half- or full-width space, after a newline, right after Chinese text, and after Chinese or English punctuation. Letters typed after `@` filter the list (`@平` finds 平台主程). `@` directly after an ASCII letter or digit (as in the e-mail address `me@example`) still does not open it.
- The full-width `＠` (U+FF20), which a Chinese input method types for the same key, did not open the picker. It now opens it in the same places as `@`. Picking an Agent replaces it with a half-width `@`, so the text reads `@名字 `.
- Pressing the composer's `@` button opened the picker and closed it again about 160 ms later: the click took focus from the text box, and the text box's blur timer closed the picker. The button no longer takes focus (`onMouseDown` prevents the default), pressing it cancels a pending close, and the blur timer closes the picker only if focus has left the text box. Pressing the button while the picker is open changes nothing: no second `@` is added, also when letters were already typed after the first one (`hello @平` stays `hello @平`).
- When nothing matched, the picker rendered nothing, so it looked as if `@` did not work. It now shows `没有名字含「…」的 Agent，换个字试试`, or `还没有 Agent，先在「Agent」页新建一个` when there are no Agents.
- Esc closes the picker when nothing matches too. ↑/↓, Enter and Tab work as before when there is a match.
- When nothing matches, Enter does nothing. The picker head then reads `没有匹配的 Agent（Esc 关闭）` instead of `回车插入`. To send the text as it is, close the picker with Esc first, then press Enter. Tab is not captured in this state: it moves focus as usual and the picker closes.

### Not changed
- Picking an Agent inserts `@名字 ` and sends the same `mentionedAgentIds` as before. No contract field, RPC, tool or stored structure changed. Quota, the phone top bar and the composer draft cache are not touched.
## [0.9.40] - 2026-11-25

### Fixed
- Todo #20: in the sidebar the selected topic could not be told from the other rows, and the system navigation at the bottom (用量与配额, 定时任务, 运行记录, Agent, 配置中心) looked like five more topic rows. The selected row was a white card on a sidebar that was 95% white (1.105:1), hover was a darker grey than the selection, and the edge of the sidebar and the line above the system navigation were 8%-alpha lines.
- The sidebar has its own opaque colour steps, light and dark: `--ek-nav-bg`, `--ek-nav-hover`, `--ek-nav-selected`, `--ek-nav-line`, `--ek-nav-rail`, `--ek-nav-content-fg`, `--ek-nav-system-rail`. The sidebar is one step darker than the main area and has a 1px opaque edge. A row at rest has no fill, hover is a light neutral fill, and a selected row has a darker neutral fill, a 3px rail on the left and 600-weight text.
- Measured in Chromium from the computed styles, with the plugin's fallback colours (light / dark): selected row against the sidebar 1.30:1 / 1.62:1 (was 1.105:1 / 1.20:1); hover 1.13:1 / 1.22:1, a different colour from the selection and weaker; brand rail 5.4:1 / 7.5:1; sidebar edge against the main area 1.37:1 / 1.70:1. With the host colours found in the Web UI stylesheet on the development machine: selected 1.30:1 / 1.59:1, hover 1.13:1 / 1.23:1, rail 5.4:1 / 6.5:1, edge 1.36:1 / 1.64:1.
- Project and topic rows use a stronger text colour (`--ek-nav-content-fg`); the system navigation keeps the secondary text colour, so it is one step quieter (text contrast 13.0:1 against 7.0:1 in light, 14.1:1 against 10.2:1 in dark, fallback colours). A selected system page has an ink rail and an ink icon; a selected topic or project has the brand rail and a brand icon. In the phone drawer the rail of the selected destination is on top of the tab.
- The project group, the topic group and the system navigation are separated by 1px lines (1.24:1 / 1.76:1 against the sidebar).

### Changed
- The space between the groups in the scrolling part of the sidebar (projects, topics) is 21px instead of 14px. Before, the groups were separated by a 14px gap with no line. Now there is 10px above the line, the 1px line, and 10px below it, so the line does not touch the last row of one group or the heading of the next. The list of topics starts 7px lower for each group above it. In the stylesheet: `.ot-left-scroll` `gap` 14px to 10px, and `.ot-left-scroll > div + div` gets `border-top: 1px` and `padding-top: 10px`.

### Not changed
- A running topic that is not selected has no fill: it shows the pulsing dot and the `运行中` tag, as since 0.9.10.
- Row heights are the same (34px on desktop, 40px on a phone, 52px for the drawer tabs). The quota cards, the composer draft, the @ picker and the wrapping of the phone header are not touched.

### Notes
- No contract field, RPC, tool or stored structure changed. `--ek-surface-dim` and `--ot-sidebar` are still defined and used by other surfaces; the sidebar no longer reads them.
- The contrast figures depend on the host theme. The test `tests/v0940-sidebar-nav-contrast.test.mjs` resolves the rules that apply and checks the thresholds for the fallback colours and for the sample host colours, light and dark.

## [0.9.38] - 2026-11-25

### Fixed
- Progress of a card could reach nobody. When the Chief created a card with `create_todo` and gave no `topic_id`, the card was bound to a new topic made for it, with no Chief session, and the wake for a topic without a Chief session was skipped without a message, a `wake_log` row, a timeline entry or a log line. A card created without a topic id now goes to the topic of the Chief session that made the call (`run.identity.sessionId`). If the call does not come from a Chief session, it goes to a topic of the project that has a Chief session.
- If neither exists, the card goes to a topic of the project without a Chief session (a new one is created with Autopilot off, so its gates wait for the user). That topic gets a system message starting with `无人值守话题：#<number>`, and the sidebar shows `无人值守` on a topic that watches cards and has no Chief session.
- A watching topic without a Chief session now gets the `关注的任务有进展` message, with `（本话题没有总管会话，未唤醒总管）` in the notice, and the card timeline says so. A watching topic that is archived or deleted gets a timeline entry `进展通知未送达：…` on the card. Both cases write a warning to the host log and a row to `wake_log`.
- A card watched by a topic without a Chief session and by a topic with one still wakes the Chief: the two cases use different `wake_log` keys.

### Notes
- No contract field, RPC, tool or stored structure changed. `wake_log` gets rows with two new key forms, `<wake key>:unattended:<topicId>` and `<wake key>:undelivered:<topicId>`. The description of `createTodoInput.topicId` and of the `create_todo` tool's `topic_id` states the new order.
- A topic id that is given is used as before.

### Not changed
- Topics, cards and watches stored before this version are not moved. A card that already sits in a topic without a Chief session stays there; its next progress is written to that topic with the notice above.
- A topic without a Chief session that existed before this version keeps its Autopilot setting. A card in such a topic with Autopilot on can still get a gate assigned to the Chief; the `无人值守` tag and the notice show that nobody will act on it.

## [0.9.37] - 2026-11-25

### Fixed
- Since 0.9.35 a table in a Chief message had 16px of space above and below it instead of 8px. The table container added in 0.9.35 has an 8px margin, and the table inside it kept its own 8px margin: the rule meant to remove it (`.ot-md-table > table { margin: 0 }`) had the same specificity as the later rule `.ot-md table { margin: 8px 0 }` and never applied. The container scrolls sideways, so the two margins do not collapse into one. The rule is now `.ot-md .ot-md-table > table`, which wins in any order; the space is 8px again. A message that starts or ends with a table no longer has 8px of extra space at that end.

### Changed
- The 0.9.35 entry below gave `1400px sideways` next to the width of a different message. It now names both measured messages: the line (130 characters, not 150; 1011px in a 328px column) and the 240-character string that produced the 1400px.

### Notes
- No contract field, RPC, tool or stored structure changed. A table that is not inside `.ot-md-table` (Markdown file preview in the project page) keeps its 8px margin. Table borders, text size and cell padding are unchanged.

## [0.9.36] - 2026-11-25

### Fixed
- The Chief's final answer could flash by and disappear when a turn ended. The host stores the last assistant message a moment after it reports the run as finished, so the sync done at that instant could miss it, and the page dropped its streamed copy at the same instant. The server now runs follow-up syncs by itself through a new `settle` scheduler action (first pass about 1s after the turn was seen finished, then up to 3 retries about 2s apart, until the host has no newer message). It does not depend on an open browser. Repeating it, or running it at the same time as another sync, never adds a second copy: a host message is stored once per topic, enforced by a unique index on `(topic_id, host_message_id)`.
- A message that fell out of the newest 80 host rows was never copied (a turn with many tool calls pushes earlier text out of that window). The sync now pages back until it reaches a message the topic already holds, at most 12 pages of 80 rows.
- The background reconcile pass skipped a topic entirely when the host could not say whether its session was working. It now still copies new messages and leaves the running flag as it is.
- A topic could stay marked as running after its turn ended when the host message read failed at that moment. The follow-up syncs clear `isRunning` and `activeRunId` on the first successful pass in which the host reports the session as idle, unless a new turn has started.
- Two turns that ended with the same text (for example `好的。` twice) kept only the first answer: the sync treated a host message with the same text within 120 seconds as a duplicate. The host message id is now the only key; matching by text applies only to a stored message that has no host id.
- Overlapping syncs could store one host message twice. On first start of this version, rows that repeat the same host message in a topic are removed (the first one stays) and the unique index is added. Messages typed in the plugin, which have no host id, are not touched.
- In the chat, the streamed answer is no longer removed when the turn ends. The part that is not in the saved list yet stays visible with `正在保存这条回复…` and is removed once the saved list has it. "Has it" means a saved message with a host id newer than the last one saved before the turn started, so the same sentence from the previous turn does not count. After 8 seconds without it, the note changes to `这条回复还没保存到对话记录` with a `重试同步` button. The held text is kept in the browser's `localStorage` (`ekko_todo_held_reply_v1`, newest 8 topics, 60,000 characters each, dropped after 24 hours), so a page reload shows it again.

### Added
- Developer trace for the chat stream, off by default: `localStorage.setItem('ekko_todo_debug_stream', '1')` records the streamed text length at turn end, whether the saved list already had the reply, and when the held copy was removed, to `window.__ekkoStreamLog` (newest 200 entries) and `console.debug`.

### Not changed
- Messages lost before this version are not back-filled when a newer message of the same topic is already saved.
- A topic whose host session state stays unknown keeps its running flag; only a known idle state or a finished-run event clears it.
## [0.9.35] - 2026-11-25

### Fixed
- A long line in a fenced code block could push the Chief chat far past the screen edge, so the chat could be swiped sideways. The inline-code rule `white-space: nowrap` also applied to code inside a fenced code block, and there was no rule for the block itself. Measured in a 390px wide chat: a message with one 130-character line was 1011px wide in a 328px column, 683px past its right edge. With a 240-character string without spaces in the same chat, that message was 1744px wide and the chat could be swiped 1400px sideways (content 1790px wide in the 390px chat). Fenced code blocks now wrap inside the message (`white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%`), for lines with spaces and for long strings without spaces. After the change the same message is 328px wide and the chat does not scroll sideways, at 390px and at 1440px.
- The same rule joined every line of a fenced code block into one line: a four-line block was shown as a single line. Line breaks in fenced code blocks are kept now, also for a code block inside a list item.
- A fenced code block has one background for the whole block instead of one strip per line.
- A table wider than the message pushed the chat sideways as well (598px in a 328px column in the measured case). Inline code in table cells can wrap now, and each table sits in a container (`.ot-md-table`) that scrolls on its own when the first column alone is still too wide. The first column keeps `white-space: nowrap`.

### Notes
- No contract field, RPC, tool or stored structure changed. Markdown rendered by `renderChatMarkdown` puts each `<table>` in `<div class="ot-md-table">`.
- A code block scrolls inside itself (`overflow-x: auto`) only if something still cannot wrap; no such case was found.
- The changelog check of the loop guard test finds its entry by wording instead of by the current version number.

## [0.9.34] - 2026-11-25

### Fixed
- On a phone the Agent page showed 12px labels and headings over 16px field text. The rule that keeps iOS Safari from zooming sets every field to 16px, but nothing else on the page followed, so the captions were the smallest text and the values the largest. Below 780px the Agent page now uses one scale: 13px for labels, hints and tags, 15px for names, headings and buttons, 16px for field text. No text on the page is under 13px (66 text runs were 12px before). The three sizes are fixed values and do not follow the host `--font-size-base`, so a host that raises its base size no longer enlarges this page on a phone.
- The Agent editor put three fields in one 390px row, because its field grids were inline styles that a media query cannot override; a select showed `工作区可…`. The grids are now classes: desktop keeps the same columns, a phone shows at most two fields per row with long ones on their own row, and phones under 360px show one per row.
- The editor was one 1626px column at 390×844. Its three blocks (头像与职责, 模型配置, 权限、轮次与提示词) now fold on a phone, each closed block showing its values in one line (for example `工作区可写 · 按需确认 · 轮次不限`). An existing Agent opens with the model chain open and the other two closed, 844px tall, so the whole Agent reads on one screen; a new Agent also opens 头像与职责 because the name is required. With one model being edited the page is 1252px (1972px before); with every block open it is 1566px (1626px before).
- Quick-pick chips (常用岗位快选, 轮次) are one row that scrolls sideways instead of three wrapped rows. Model rows are two fixed lines with a single 编辑 button; 设为首选 / 上移 / 下移 / 移除 are labelled buttons inside the open editor on a phone. The bar with the Agent name and 保存配置 stays at the top while the form scrolls.
- `-webkit-text-size-adjust: 100%` (and `text-size-adjust`) is set on the plugin document, so iOS Safari does not enlarge text on its own in landscape or on wide content.
- Touch targets on the page are still at least 40×40px on a phone. Desktop is unchanged: the 1440px render is pixel-identical before and after.

## [0.9.32] - 2026-11-25

### Fixed
- The Chief could repeat one sentence and re-read tool schemas for minutes without calling the tool. In the recorded case (host session `7e71cf1e…`, 10:58:13–11:05:29) it issued 101 `tool_describe` calls and 0 `merge_build` calls, and wrote 「审查通过，主仓已干净。现在合并 #18。」 word for word more than ten times. The host marks such results as `byte-identical` but only stops the turn when `tool_loop_guardrails.hard_stop_enabled` is on, which it is not for these sessions. The plugin now ends the turn itself when either holds within one turn:
  - the same sentence (4 characters or more, whitespace ignored) is written 3 times in a row and no real tool was called in between, or 6 times in a row regardless;
  - `tool_describe` is called 5 times in a row and no real tool is called in between (`tool_search` does not count as a real call).
- When a turn is ended this way the host run is stopped, the topic stops showing as running and can take the next message, and one system message is stored: `检测到重复输出，已中止本轮：…发「继续」可让总管接着做。` Tool events that still arrive from the stopped run do not mark the topic running again and do not add a second message. Queued messages for the topic are sent next, as after any other stop.
- The chat shows that message as an amber warning row instead of the small grey progress line. While a turn is still running, the chat also shows `检测到重复输出，正在中止本轮…` as soon as the live stream meets the same conditions.
- Chief instructions gain rule 10: after one `tool_describe` returns a schema the next step must call that tool; the same tool is not described twice in a turn; announcing an action and then describing again is not allowed.

### Notes
- No contract field, RPC, tool or stored structure changed. The stop message is an ordinary topic message with `kind: "system"`; its text always starts with `检测到重复输出，已中止本轮`.
- The limits were checked against every session in the local Hermes history: outside the three recorded loops (14, 37 and 105 schema reads in a row) the longest run of `tool_describe` calls without a real call was 3.

## [0.9.28] - 2026-11-25

### Fixed
- The Grok quota card always showed `剩余 100%`. A live call to `cli-chat-proxy.grok.com/v1/billing?format=credits` returns the weekly total as `config.creditUsagePercent` (17 at the time of the check) and a per-product split in `config.productUsage[].usagePercent`. The parser read neither field and fell through to the "period without numbers" branch, which wrote 0% used. It now reads `creditUsagePercent` for the total, adds one window per `productUsage` entry, and adds an `按需额度` window from `onDemandUsed / onDemandCap` (US cents) when the cap is above 0.
- When the vendor confirms a period but sends no usage number, the window is kept for its reset time but marked `usageReported: false`. The card shows `官方未返回已用量` with an empty meter instead of `剩余 100%`, and no pace line is computed from it.
- The Grok card states its source in `lastSnapshot.note`: `官方只返回这一个周期，不包含本地对话用量` (or `…未给出已用量；…` when there was no number). The token summary below the cards is unchanged.
- The Quota Hub card no longer drops windows after the fourth. The home quota strip is unchanged.

## [0.9.27] - 2026-11-25

### Fixed
- Text typed in the Chief chat box and files already uploaded were lost when another plugin page (board, quota, settings, agents…) was opened and closed, or when the page reloaded: the chat composer is unmounted on those pages and kept its draft only in component state. The unsent text, referenced task cards and uploaded file references are now saved per topic in the browser's `localStorage` (`ekko_todo_draft:<topicId>`) and restored when the same topic is shown again. Each topic has its own draft; switching topics loads that topic's draft and never carries text across.
- Only references the plugin already holds are stored (upload path, name, type, size) plus a small JPEG preview (at most 160 px, about 24 KB) for images; original file bytes and `blob:` URLs are never written. A topic's draft is capped at 200 KB: past that the text is kept and images are shown as `图片需要重新上传` and are not sent. Up to 40 topic drafts are kept; the oldest are removed first.
- The draft is cleared only after the message is accepted. If sending fails, the text and attachments come back into the composer.

## [0.9.25] - 2026-11-25

### Fixed
- On a phone the quota page header hid its own title and covered the content below it. Below 780px the mobile rules make buttons and selects 40px tall, but the header stayed a fixed 46px single row. Its three right-hand controls (refresh period, 全部刷新, 管理订阅源) took most of a 390px screen, so 「用量与配额」 shrank to 0px wide and 「已开启 3 / 7」 wrapped one character per line into a 112px column that hung over the first section. Below 780px the header now grows and wraps: title and count stay on the first line (the count never wraps), the controls move to the next line, and the content starts below the header. The run-history, schedules and Agent pages share this header and get the same rule. Touch targets stay 40×40 through the existing button and select rules; the count pill is not padded up to 40px. The border around the refresh-period select now grows with its 40px select instead of staying 28px. Desktop layout is unchanged.

## [0.9.24] - 2026-11-25

### Fixed
- Opening a file with a Chinese name in the repository page failed with `API Error 500: Command failed: …git show main:deliveries/202611/"2025\345\271\264…md" fatal: path … does not exist in 'main'`. The directory listing used `git ls-tree` without `-z`, so Git returned non-ASCII, quote and control characters as a C-quoted octal string and that string was used as the path. The listing now uses `git ls-tree -z` and keeps names verbatim (Chinese, spaces, quotes); reading passes that path to `git show` as an argument.
- A file that cannot be read now shows only `这个文件打不开` in the preview pane; a binary file or one over the 4 MB read limit shows `这个文件不支持预览`. Git command lines, absolute paths and `fatal:` text are no longer shown. Files over 4 MB are detected by size before reading instead of failing mid-read.
- A long preview error spread the preview pane sideways. The message container now wraps inside the pane (`max-width: 100%`, `min-width: 0`, `overflow-wrap: anywhere`).

## [0.9.23] - 2026-11-25

### Fixed
- Links in the Chief chat opened inside the plugin page. The plugin runs in a host iframe, so clicking a link such as a GitHub Actions run loaded GitHub inside that iframe and the page showed that it could not be reached. Every external http/https link rendered from Markdown (finished chat messages, the streaming reply, the Markdown file preview and the repository Markdown preview) now opens a new browser page with `target="_blank"` and `rel="noopener noreferrer"`. Links to files on the plugin host (host paths, `file://`, host download links) still open the in-page preview. A `target` written into raw HTML is removed from non-external links, so a link cannot navigate the host page.

## [0.9.22] - 2026-11-25

### Fixed
- An agent stored with an id over 120 characters (possible only in a database written before 0.9.21) could no longer be assigned: starting a build, sending a card for independent review or running a schedule with that agent failed with `agentId 超过 120 字符上限`. An over-long id that is an agent row already stored is now accepted (in full or in its shortened board form) and written as the stored id; new over-long ids are still refused, including a 1.2 MB one. Starting a build from the board with the shortened id now uses that agent instead of silently falling back to another builder.
- Deleting such an agent from the board (shortened id) left the Chief binding pointing at the deleted row. The stored id is now resolved first; if the deleted agent was the Chief, the binding moves to a remaining Chief, else to the first remaining agent. Clearing its cooldowns from the board also resolves the shortened id first, so the records are actually removed.

## [0.9.21] - 2026-11-24

### Fixed
- The board stopped loading once its state passed 1.5 MB. The size trimmer added a `snapshotTrimmed` flag that the `stateSnapshot` contract did not declare, so the first trimmed snapshot was rejected by output validation (`unknown property snapshotTrimmed`) on `get-state` and every action that returns the board. The flag is now declared.
- The trimmer only knew about diff bodies and long worker chat. Topic conversations and a growing pile of finished cards could still push the snapshot past the host's 2 MB limit (reproduced at 3.2 MB with 200 finished cards and at 3.0 MB with ten long topics). It now also leaves out older topic messages (archived and least recently active topics first, newest 60 then 20 kept per topic), shortens finished cards' worker chat to the newest 2 entries, and as a last step leaves out the oldest finished cards. Stored data is untouched, unfinished cards are never trimmed, and the most recently active topic is trimmed last.
- Marking a card done or closing it left its worktree on disk for good (one finished card held 124 MB). A worktree with nothing uncommitted is now removed at that point; the branch is kept and the worktree is recreated if the card is started again. A worktree with uncommitted changes is kept.
- Closing a card while it was building or under review left the agent session running in the background and did not start the next queued card. The session is now stopped and the queue advances.
- Cards that were not finished took no part in size trimming, so a board with many cards waiting for review could still exceed the 2 MB limit (17 review cards with full worker chat and a 20 KB plan came out at 2.02 MB). Cards that are not running now have their worker chat (newest 12, then 2), timeline (newest 12, then 6) and plan (50 KB) shortened in the returned board, and as a last step the oldest idle cards (to do / queued / failed) are left out. Building, reviewing and merging cards are never touched.
- A card's error text and timeline entries were stored at any length, so one engine error dump ended up in the database and in every board load. Stored limits: error text 2,000 characters, timeline entry 600 characters (80 entries), plan 50 KB, worker chat 24 entries of 4,000 characters. The log records only the first 2,000 characters of a cut error, timeline entry or specification together with its original length, and a failing log no longer fails the save. Oversized errors already stored are shortened when the board is loaded.
- A card's specification and title were stored at any length; four cards with 200,000-character specifications made the board 2.4 MB. Stored limits are now 20,000 characters for the specification and 200 for the title (also declared on the Chief's `create_todo` / `update_todo` tools). Oversized specifications already stored are shortened when the board is loaded; agents still get the full text.
- Cards that were building, under review or merging took no part in size trimming, so five such cards filled to the limits came out at 2.5 MB. Their worker chat and timeline are now shortened in the returned board like other cards (newest entries kept); they are still never left out. If the board is still too large after every other step, uploaded agent avatars are shown as the default avatar, specifications are cut to 4,000 characters, and the oldest failed and then the oldest waiting-for-confirmation cards are left out.
- Memories were sent to the board in full; 170 full-size memories alone were 2.1 MB. When the board is over its size budget it now carries 100 memories (pinned first, then newest) and reports how many were left out. Nothing is deleted.
- The Chief charter, a topic's error text and topic messages were stored at any length, and project avatars and queued follow-ups were sent to the board without limit; each could push the board past 2 MB (a 900,000-character charter: 2.7 MB; 20 projects with 120 KB avatars: 2.4 MB). Stored limits: charter 20,000 characters, topic error 2,000, topic message 20,000. In the returned board, project avatars fall back to the monogram as a last step (the stored avatar is kept, also when the project is saved from that view), conversations can shrink to the newest 5 and then 1 message, and only the newest 20 queued follow-ups per topic are included.
- When the board was still too large after every trimming step, loading failed, which also made an action that had already been saved look like a failure. The board now always opens: the oldest cards waiting for review can be left out too, and beyond that a reduced board is returned (marked `snapshotOverflow`).
- An unrelated change to a card (a new timeline entry, a rename) cut a long specification, plan, title or worker chat already stored down to the limits, losing the tail for good. Limits now apply only to the field being written; older long text stays stored in full and is shortened only in the returned board.
- Memories saved by the Chief, decision questions, topic briefs and queued follow-up messages were stored at any length; two 1.2 MB memories or one oversized question were enough to empty the board or make the card waiting for a decision disappear. Stored limits now match the UI: memory 4,000 characters (title 160), question and brief texts 2,000, queued message 12,000. Older oversized entries are shortened only in the returned board. Queued messages stay listed when the board is over its size budget; only their text is shortened there.
- When the board had to fall back to its reduced form it came back with no topics and no cards, which looked like everything was gone. Before reducing, whole topics are now left out first (archived, then least recently active; the current one stays). If the board still has to be reduced, every topic and card is still listed by name and state, without its contents. The UI does not show a notice for this state yet.
- Decision option ids had no limit, and a long option saved through the topic brief was stored in full even though the limit was applied first. Four options with 900,000-character ids made the card waiting for a decision disappear from the board. Options are now cleaned up first and limited afterwards: 2,000 characters per option text, 120 per option id. Older over-long options are shortened only in the returned board and can still be answered from it.
- Model settings of an agent, the default clone folder and a project's name, paths, branch, test command and description had no limit when set by the Chief; one 1.2 MB value reduced the board and emptied the agent and project lists. Paths, URLs, model ids and the test command over their limit are now refused with a clear message instead of being cut into a different value; names, labels and descriptions are shortened. Older over-long values are shortened only in the returned board. When the board still has to be reduced, agents and projects stay listed by name so the entry to fix can be found.
- Renaming an agent whose stored gateway address or other model setting was longer than the limit replaced it with the shortened text shown on the board, breaking the address. A value that is only the shortened form of what is stored is now left alone; a setting is written only when it is changed to a different value.
- Card tags, topic titles, a project's builder/reviewer reference and a schedule's run time or agent had no limit; eight 300,000-character tags made every card vanish from the board without notice. Tags are limited to 8 of 40 characters, topic titles to 160; an over-long agent reference or schedule time is refused. Older over-long tags and titles are shortened only in the returned board.
- When the Chief changed several settings at once and one of them was refused, the others had already been saved although the error said nothing was. Everything is now checked first and saved only if all of it is valid.
- The agent, reviewer and topic reference of a new card and the id and target of a memory had no limit when set by the Chief; a 1.2 MB value made the new card missing from the board or emptied the memory list. Values over 120 characters are now refused and nothing is saved. Older over-long values are shortened only in the returned board, and such a memory can still be edited or deleted from it.
- An agent id and the Chief agent id had no limit; two 1.2 MB agent ids made even the reduced board 2.4 MB, so it could not be loaded at all. Ids over 120 characters are now refused, older over-long ids are shortened in the returned board (and still work for saving and deleting), and the reduced board is checked once more at the end so it can never exceed the host limit.
- Renaming an agent cut an older system prompt longer than 20,000 characters down to that length for good. The prompt is now only written when it is actually changed; an older long prompt is shortened only in the returned board.
## [0.9.20] - 2026-11-24

### Changed
- Board on a phone shows one lane per screen. A tab strip (待开始 / 执行中 / 待你处理 / 已完成, each with its count) switches lanes, swiping still works, and cards use the full width (366 px instead of 244 px in a sideways scroller). The board opens on the lane that needs you, else the running one, and returns to the lane you left after switching to the chat.
- Board on desktop: when four lanes do not fit, empty lanes fold into the 44 px rail so lanes that hold cards stay on screen (at 1440 px 已完成 used to be pushed off the right edge). A lane with cards never folds by itself, a board without cards keeps all four lanes, and a lane you fold or reopen by hand stays that way.
- Sidebar is 220 px wide (was 198 px) and shows the topic age without 「前」, so topic titles get about 122 px instead of 88 px (truncated titles on the live board at 1440 px: 11 of 15 before, 6 of 15 after). The width is one token (`--ot-sidebar-w`, `SIDEBAR_WIDTH`).
- Navigation drawer (phone and narrow desktop): 配额 / 定时 / 记录 / Agent / 设置 sit in one row at the bottom instead of five stacked rows, leaving the height to the topic list. Full names stay as accessible names and tooltips.
- Topic brief above the chat can be folded to a single line. On a phone it starts folded unless it holds a decision for you; a new decision opens it again.
- Project page header on a phone is two rows (name and actions, then view switch and branch); the single row overlapped the branch picker, the view switch and the action buttons.

### Fixed
- Phone hit areas below 40 px: sidebar section toggles, checkbox rows in the new topic / new task dialogs, switches, reasoning-effort stops (at most four per row, so seven stops are two rows; they were 37 px wide in one row, and with more than four stops the slider track is hidden on a phone because the stops are the control), concurrency buttons (now 4 × 2), the queue-send button, the quota auto-refresh select, the project view switch, branch picker, file tabs, file rows and file filter, and the brief reply controls.
- Text fields on a phone use 16 px, so iOS Safari no longer zooms the page when a field is focused.
- The chat header on a phone no longer repeats the menu button that the top bar already has.
- Project initials in 18 px avatars were 11 px; the smallest text size is 12 px everywhere.

## [0.9.19] - 2026-11-24

### Changed
- `INSTALL.md` is rewritten as a first-time guide (简体中文) checked step by step on a fresh Studio 0.8.30 with an empty data directory: what you need (host version, super administrator, Node.js, Git, an installed engine), the five install steps with the exact button labels, what the first screen looks like, how to pin the plugin to the sidebar, which Studio features it connects to and what it cannot do, and a troubleshooting table that quotes Studio's own error text for a wrong path, a ZIP file, a relative path, a non-administrator account, a disabled plugin and a second install. The previous guide named a "Local Install" menu and a "check and save" step that do not exist in Studio, and did not say that an installed plugin must be upgraded from its details page.
- `README.md` gains a three-step quick start, states that Studio 0.8.30 is the only tested host, and corrects the MCP tool count from 26 to 31.

### Fixed
- When the Chief could not start because the chosen engine has no usable runtime in Studio, the chat banner and the toast showed the host's raw JSON envelope (`{"ok":false,"status":"failed","event":"run.failed",…}`). They now say in plain words that the engine is not ready, where to install it in Studio and where to switch the Chief to another engine, followed by Studio's original message. Other launch errors keep Studio's wording with the JSON wrapper removed; failover decisions still use the raw text.
- After such a failed start the chat kept showing "大总管运行中…" with a running timer next to the failure banner (still there after 90 s on the test host). A message that could not be sent now takes the running state back at once; interrupting a live run is unchanged.
- Opening the "添加项目" dialog froze the board for up to 30 s. Listing GitHub repositories cached the sign-in status with an explicit `repos: undefined`; that value then travelled inside every board snapshot, which Studio rejects as non-JSON (`stateSnapshot.runtime.githubCli.repos: expected JSON data`), so nothing on screen updated, including a message sent right after closing the dialog. The cached status now omits the field.

### Removed
- A private topic id from the 0.9.15 entry of this changelog.

## [0.9.18] - 2026-11-24

### Fixed
- Dragging a board card into the chief chat produced a reference chip whose long title wrapped to two lines inside the fixed 22 px chip and spilled over the chip below. Attachment chips (cards and files) now stay on one line, card titles are truncated with an ellipsis (max 360 px, never wider than the composer) and show the full `#number title` on hover.

## [0.9.17] - 2026-11-24

### Changed
- Replaced the former gradient squircle/checkmark with selected brand master **01 间隔 / Interval** in `assets/logo.svg` and the inline `BrandLogo` component: the two square-cap 8-unit brackets and 14×14 centre block are unchanged, with `currentColor` providing automatic light/dark inversion.
- Exported `assets/logo.png` from the final SVG through Chromium at 128×128. A transparent ink mark measured only 1.444:1 against Studio's dark navigation surface, so the manifest icon uses a flat paper (`#f2f0e9`) tile with the ink (`#191c19`) mark (15.077:1), without gradients, rim light, glow or shadows. The `brand/v2/` proposal archive is unchanged.

## [0.9.16] - 2026-11-24

### Fixed
- AUTO switch looked dead (regression from 0.9.11). The click reached the server and was saved, but the board only re-renders when its snapshot fingerprint changes, and the topic part of the fingerprint listed fields by hand, relying on `updatedAt` for the rest. Since 0.9.11 settings such as autopilot no longer bump `updatedAt`, so the new value never reached the screen and the next click sent the same value again. Every scalar topic field now takes part in the fingerprint (moved to `src/client/state-fingerprint.js` with tests); project, model config and session changes are covered too.
- A board refresh that was already in flight when you clicked could land after the click's own result and put the old value back on screen. Writes now mark the state; background reads (`get-state`, topic sync) that started before a write finished are dropped and re-run.

## [0.9.15] - 2026-11-24

### Fixed
- Opening some topics slid down for ~0.6 s and still stopped short of the newest message. The chat reused the previous topic's scroll position, animated down with CSS smooth scrolling, and the scroll events of that animation turned "follow the bottom" off, so content that rendered afterwards (synced replies, entrance animations, images) was not followed (measured on one topic: 1,095 px animated, ended 65 px short). Now opening a topic jumps to the newest message before paint, and the view stays pinned while content keeps growing; if you scroll up to read history it is left alone.

## [0.9.14] - 2026-11-24

### Fixed
- 用量与执行概览 always showed 0 tokens. The plugin waited for `chat.usage.updated` on the host event bus, which the host never publishes there (usage only travels on the per-session `/chat-run` stream), so the plugin ledger stayed empty. Studio's session API returns only the last model call of a session. Totals now come from the Hermes engine's own per-session ledger (`~/.hermes/state.db`, read-only, the engine directory the plugin already reads `config.yaml`/`.env` from) for every chief, build and review session the plugin created: input/output/cache/reasoning tokens, model calls and cost. Sessions of other engines fall back to the plugin's own records; nothing is counted twice. The panel names its data source and session coverage.

## [0.9.13] - 2026-11-24

### Fixed
- Opening a repository from the sidebar silently set the board's project filter, so topics from other repos showed a board without their tasks. The repo page and the board filter are now separate: clicking a repo only opens its page; the board's project filter changes only from the board's own filter menu (and no longer jumps to the repo page).
- New task / new topic / schedule defaults follow the open repo page, else the current topic's repo, else the board filter, instead of whichever repo was visited last.

## [0.9.12] - 2026-11-24

### Fixed
- Topics disappeared when another repository was selected. The sidebar showed only topics of the selected repo (plus unassigned ones). Topics are independent of the repo selection: the topic list always shows every topic; selecting a repo still opens its workspace and filters the board.

## [0.9.11] - 2026-11-24

### Fixed
- Clicking a topic moved it to the top of the sidebar. Opening a topic re-syncs its chief session, and writing the run state (`isRunning: false`) bumped `updated_at`, which orders the list. Now only real activity moves a topic: a new message, a new decision brief or a new error. Run-state bookkeeping and housekeeping (rename, pin, archive, project, model config, digest cursor) keep the timestamp; the idle sync no longer writes at all, and back-filled old messages never move a topic.

## [0.9.10] - 2026-11-24

### Fixed
- Kanban cards no longer reshuffle while builds run. The board used the server order (`updated_at DESC`), which every build event bumps. 待开始 / 执行中 / 待你处理 now keep creation order (oldest first, `#number` as tie-break; 待你处理 still puts items waiting on you first); 已完成 keeps the newest finished on top.
- Topic sidebar: a running topic had the brand "selected" tint and overrode the selected style, so the selected topic and running topics looked alike. Running is now shown only by the pulsing dot and the 运行中 tag; the selected topic is a raised card with a solid brand rail and bold text, also while it runs.

## [0.9.9] - 2026-11-24

### Added
- Chat renders images and opens files that live on the plugin host, the same way over LAN, tunnels (节点小宝 / FRP / SSH reverse tunnel) and a VPS reverse proxy:
  - Markdown images with host paths (`![x](/Users/…/a.png)`, `<C:/…>`, `file://…`, `/api/studio/files/download?path=…`) show inline; local links and bare paths in Chief messages, user messages, the worker chat and the todo spec/plan become preview links; bare image paths get a thumbnail strip (max 8).
  - Click opens a preview: images (with ←/→ gallery), video, audio, PDF, text/code and Markdown (rendered); other types download. Copy path and download buttons.
  - Bytes travel through the new read-only `read-local-file` RPC in ≤1 MB chunks (each response < 2 MB host JSON limit) and become iframe Blob URLs, so no host login token, cross-origin URL or public file route is involved. Images load lazily when scrolled into view; at most two reads run at once.
  - Secrets are refused: `.ssh/.gnupg/.aws/.kube/.docker/secrets/Keychains` folders, `.env*`, keys/certificates, `auth.json`, `credentials*`, token files and SQLite databases; paths must sit under the home directory, temp dirs, `/Volumes`, `/mnt`, `/srv`, `/opt` or `/data`. 60 MB cap.

### Fixed
- Board refreshes are coalesced (one `get-state` in flight, one queued, ≥ 800 ms apart). A running build used to trigger 13 `get-state` calls per second, which tripped the VPS nginx limit (52 × 429 in one minute over the public domain).
- Plugin RPCs rejected by a rate limiter (`API Error 429`, e.g. nginx `limit_req` on the VPS entrance) are retried like edge 404/502 misses: the request was never applied.

## [0.9.8] - 2026-11-23

### Fixed
- "API Error 400: Plugin value exceeds the JSON size limit" when creating a topic (and on every board refresh): one todo stored a 3.2 MB diff of the minified `dist/client.mjs`, pushing the board snapshot to 3.7 MB, over the Studio host's 2,000,000-byte limit for plugin values.
  - Diffs are clamped on write and on read: generated/minified files (`dist/`, `build/`, `*.min.*`, lockfiles, lines > 4000 chars) keep their +/- stats but no body; lines are capped at 500 chars, each file at 40 KB and each todo at 160 KB.
  - The board snapshot is kept under 1.5 MB: if needed, diff bodies are dropped (finished todos first) and marked `hunkOmitted`; the drawer loads them on demand via the new `get-todo-diffs` RPC.
  - Live snapshot 3.7 MB → 0.44 MB.

## [0.9.7] - 2026-11-23

### Changed
- "Ekko Calm" design layer, built from Linear's 2025 refresh (navigation recedes, structure felt not seen), Vercel Geist (ring borders + two-part shadows, one radius family) and Radix Colors step semantics, with Ekko's own identity (天青 accent, brand-tinted selection and user bubbles, square badges, status rails):
  - one radius family (6 / 8 / 12 / 16), ring borders instead of hard 1px lines, tinted two-part elevation for cards, composer, popovers, sheets and modals, blurred overlay;
  - dimmer sidebar with a raised active item; quieter separators;
  - buttons: Ekko-blue primary with sheen, ring secondary, tactile press; consistent brand focus ring; fields with brand focus glow;
  - cards lift on hover, lanes become quiet wells; user bubbles are brand-tinted; links styled; thin scrollbars; reduced-motion respected.
- Light 天青 darkened to #1A65B0 and teal to #0F6E68, dark wisteria lightened, so tinted badges and project chips pass WCAG AA (0 violations, light and dark).
- Agent moved out of 配置中心: it has its own sidebar entry and page; the settings modal keeps 项目仓库 / 总管与章程 / 运行环境 (the Studio settings slot still embeds the Agent editor). 配置中心 stays in the sidebar.

## [0.9.6] - 2026-11-23

### Fixed
- `run_build` is idempotent: when the todo's build session is still running it re-attaches (phase back to `building`, timeline note) instead of sending a second run into the busy session. Previously the host blocked that run for 120 s, the MCP tool spun until "The operation was aborted due to timeout", the todo was marked failed, and a retry then failed again with "session … is already running" while the worker kept working.
- Run-start recovery also treats "session is already running" as in progress, and after a timeout trusts live session activity / a fail-closed probe instead of marking the build failed.

## [0.9.5] - 2026-11-23

### Changed
- Chief model / effort moved out of the cramped composer toolbar into its own line above the composer (with AUTO next to it). Desktop shows "大总管 · model · effort", phones keep model + effort; nothing is truncated at 360–1440px.
- Chief quick config opens as a side sheet on desktop (440px, scrollable) and a bottom sheet on phones (full width, 40px controls) instead of a popover that clipped selects and text.
- Agent configuration is now a full page (sidebar「Agent」, settings tab, chief sheet, "新建 Agent" all lead there): 280px list + wide editor on desktop, list → editor with a back button on phones. The settings modal keeps a pointer card; the Studio settings slot still embeds the editor.

## [0.9.4] - 2026-11-23

### Fixed
- When the board is opened through a tunnel (e.g. 节点小宝) the edge sometimes answers with its own `404 page not found` / `502` before the request reaches Studio, which showed up as "API Error 404: 404 page not found". Plugin RPC calls now retry these edge misses up to 3 times (0.4/0.8/1.2 s) and, if the tunnel stays down, show a plain Chinese message. Real plugin errors and dropped connections are never retried.

## [0.9.3] - 2026-11-23

### Added
- Delete a todo card from the task drawer (trash icon → inline confirm). Live build/review is stopped first, the worktree is removed, merged branches are deleted with `git branch -d`, unmerged branches stay in the repo; watches, wake log and schedules are dropped. Refused while merging.
- `todo_counters` keeps a per-project high-water mark so todo numbers (and task branch names) are never reused after a delete.

### Fixed
- Chief composer: the textarea no longer draws its own rounded focus ring flush against the text (it overrode the container and clipped the first characters); focus is shown on the composer frame, and the textarea auto-grows up to 40% of the viewport instead of hiding text behind a fixed two-row box.
- Hit targets raised to 32px desktop / 40px touch for message actions, progress chips, small inputs, the mobile back button and switches.
- Home quota chips fade at the edge instead of being cut mid-chip under the refresh button on mobile.

## [0.9.2] - 2026-11-23

### Fixed
- Chief busy-poll guard no longer flags one-off reads (worktree `git log`/`grep`, a single SQLite query); only long `sleep`, sleep loops and `watch`/`tail -f` count.
- When the topic has unfinished todos, the first long `sleep` ends the Chief turn at once (todos are auto-watched, so a wake is guaranteed); warn-then-stop only applies when nothing is pending.
- Poll strikes reset at each new Chief turn, so a fresh wake turn is never stopped because of warnings from the previous turn.
- Repo-mutation audit only blames the Chief for repos referenced by its own tool calls in that turn; commits made by the user or other sessions meanwhile no longer raise a false "总管治理审计" warning.
- Chief running a project's tests or gate script (`pytest`, `npm test`, `./scripts/…`) to verify a merge is no longer reported as a code mutation; git writes, `rm`/`mv`, `sed -i` and builds still are.
- `write_file`/`patch` governance alert now checks the target path: only writes inside a project repo are flagged; deploy scripts, scratch files and evidence written elsewhere no longer raise "治理约束告警".
- A Chief turn that ends on a tool result (model returned empty replies) now posts a visible notice with the model name instead of going silent.

## [0.9.1] - 2026-11-23

### Fixed
- **大总管不再长时间“卡在调用中”**：根因是总管在回合内用 `sleep N` + 直读插件 SQLite 轮询任务进度，单回合占用 25 分钟以上。现在提示词明令禁止轮询并要求派工后结束回合等待自动唤醒；运行期检测到轮询会先提醒、再次出现即自动结束该回合，并为话题内未完成任务登记关注，状态变化时自动唤醒。
- **启动超时不再误判失败**：`sessions.run` 客户端超时（`The operation was aborted due to timeout`）时先探测会话，若实际已在运行则按启动成功处理，不再把任务标成失败或重复派发。
- 治理审计与轮询检测改为从会话最近一次工具调用读取参数（宿主事件只带工具名），此前的越权改码检测实际从未拿到参数。

### Added
- **运行记录（独立会话视图）**：侧栏「运行记录」、话题顶栏与任务抽屉「调用明细」入口；按总管 / 构建 / 审查列出会话，展示模型、提供方、耗时、工具调用数与异常数、输入输出 Token，时间线逐条呈现输入、推理、回复、工具参数与结果（含耗时与失败标记），支持筛选、复制与运行中自动刷新。新增 RPC `get-session-trace`（仅限本插件创建的会话）。
- **Diff 视图重排**：变更文件索引、文件级新增/修改/删除徽标与增删比例条、旧/新双行号表格、`@@` 上下文、截断提示、自动换行与全部展开/收起。

### Changed
- **品牌协调色卡**：以 Logo 天青为主色，统一为 天青 / 松绿 / 赭黄 / 砖红 / 紫藤 / 青碧 / 石板灰 七色（亮暗两套），卡片状态、任务类型、项目色、配额徽标、头像底色、Diff 与图表全部取自同一色卡；卡片去掉渐变底，仅保留状态色条。
- **AUTO 开关**：开启为实心松绿 + 光圈并显示「AUTO 开」，关闭为灰色虚线「AUTO 关」。

## [0.9.0] - 2026-11-23

### Added
- **项目内原生配额余量检测（脱离 CodexBar 与 Magpie）**：在 `src/server/quota-engine.mjs` 内置 Kimi Code、Grok（`~/.grok/auth.json` + `cli-chat-proxy.grok.com`）、DeepSeek、谷歌反重力（本机 Antigravity `language_server` Connect-RPC 直连 + OAuth 回退）、ChatGPT/Codex（`~/.codex/auth.json`）、Claude（OAuth 凭据/钥匙串）、OpenRouter 及自定义余额接口检测，内置周期进度结余计算与独立 `usage_records` 统计表。
- **首页配额简略条 (`HomeQuotaStrip.jsx`)**：在工作台首页（桌面端看板顶部与移动端顶部栏下方）直接展示置顶监控源的余量/余额与迷你进度条，支持一键刷新和点击直达详情页。

### Changed
- **主题变量与样式收敛**：`styles.css` 暗/亮双主题全面消费 Studio 宿主 CSS 变量，移除 `App.jsx` 1.2s 明暗轮询，组件区硬编码颜色由 211 处归零，字号统一收敛至 4 档（12/13/15/20px），修复暗色 `新建定时` 按钮对比度，桌面图标按钮提升至 32px、移动端可点触控区统一至 ≥40px。
- **看板自适应排版**：`KanbanBoard.jsx` 与 `.ot-board-grid` 改为 `minmax(216px, 1fr)` 自适应铺满，消除宽屏分栏与全屏模式右侧大面积留白。
- **纯中文与文案精简**：取消多国语言 UI 分支，统一中文元信息；精简 Agent 轮次、故障切换、总管约束、设置项、引导页、定时页与配额页的冗长说明。

### Removed
- 彻底卸载 Magpie 网关/缓存/`usage.jsonl` 读取与全部界面表述，并移除外部 `codexbar` CLI 子进程调用；旧库启动时自动清理遗留 `magpie` 项并迁移 `source_mode`。

## [Unreleased] - 2026-11-23 audit fixes

### Fixed
- A review that requests changes now parks the todo at the review gate (`gateKind: "changes"`) instead of entering `building` with no worker run; the next reconcile tick can no longer settle the old build session and flip the rejected change back to merge-ready. `request_changes` with an empty note forwards the reviewer findings, and any new build run resets `evidence.reviewVerdict` to `none`.
- Merging is checked on the server: only todos in `review` can be merged. The Chief (`merge_build`) additionally needs topic AUTO, project `autoMergeAfterReview`, an APPROVED review of the current build, a passing test gate, no active question and no deploy redline. Refusals come back as `ok: false` with the reasons.
- Test gate timeouts kill the whole process group, and the gate resolves even if a background child keeps stdout open.
- A successful merge puts the main checkout back on the branch (or commit) it was on.
- `maxConcurrentBuilds` holds under parallel dispatch (slot reservation closes the check-then-act race).
- Queued Chief messages and wakes are put back in the queue when their launch fails (up to 3 attempts, 30 s back-off) and the topic gets a visible notice; a failed direct wake is queued instead of dropped. Two near-simultaneous sends to one topic now produce one Chief run plus one queued item.
- Deleting a project stops its live runs, removes its worktrees, todos, watches and schedules, and detaches its topics. Branches in the user's repository are kept.
- Token usage reads Magpie's `t` timestamp (and epoch seconds/ms); records without a usable timestamp only count toward「全部」.
- `autoDispatch` / `autoAnswerRoutine` are now enforced for Chief MCP actions; settings and dialogs describe what the switches and the test command actually do.

### Changed
- Light theme secondary text reaches WCAG AA contrast; queued todos can be cancelled from the drawer; rejected reviews show「按审查意见返工」first.
- Plainer interface copy (welcome, onboarding, settings, quota hub, schedules); removed the third-party docs link from the schedules empty state.

## [0.8.0] - 2026-11-23

### Added
- **Todos-Grade Project Workspace (`ProjectWorkspace.jsx` + 5 Pure Read-Only Git Browser RPCs)**:
  - Clicking any project in the sidebar now opens a dedicated full-width Project Workspace with a contextual top bar (`<` back, project emblem, Git branch picker annotating Todo branches with `#number` & title, and center `Files` / `Tasks` segmented switcher).
  - **Files & History View**: Pure read-only browsing via `git ls-tree` / `git show` / `git log` (zero `git checkout`, zero main working tree pollution), featuring monospace folder-first directory trees, Markdown preview/source toggle, line-numbered code viewer, raster image preview, file copy/download, and commit history with full unified diff inspection.
  - **Project Tasks View**: Wide search bar, one-click `执行中` running filter, multi-dimensional Filter & Sort popovers, and a **Table View vs Card View** toggle built for complex multi-task projects.
- **Completion & Human-Attention Notifications + Full 16 Todos Keyboard Shortcuts (`notifications.js` + `ShortcutsDialog.jsx`)**:
  - Automatic detection of Todo completions, failures, human approval gates, and Chief waiting-on-you events with bottom-right interactive popup cards, synthesized Web Audio chimes (zero external audio files), and optional OS desktop Notification API alerts, all configurable with a live test button in Settings → 运行环境.
  - Implemented all 16 Todos shortcuts (`⌘K`, `⌘P`, `⌘J`, `⌘N`, `⌘[`, `⌘B`, `⌥↑`/`⌥↓`, `⌘⌥B`, `⌘⇧Enter`, `N`, `⌘⌥S`, `⌘⌥Enter`, `⌘,`, `⌘/`, `Esc`) plus a warm-paper `⌘/` shortcut cheatsheet modal.
- **Magpie-Inspired Quota & Token Hub (`QuotaHub.jsx` + `src/server/quota-engine.mjs`)**:
  - Added dedicated **`用量与配额`** Hub entry directly above `配置中心` in the sidebar.
  - Supports **Kimi 订阅**, **Grok 订阅**, **DeepSeek 余额**, **谷歌反重力 (Google Antigravity)**, **ChatGPT/Codex**, **Claude**, **OpenRouter**, and **Magpie / Custom Balance Gateways** with opt-in toggles, max-4 default view + **`展开全部`** toggle, compact per-card key/channel config popovers (strictly masked server-side storage), independent single-provider probing (`refresh-quota-provider`), coexisting manual + configurable auto-refresh, and a Magpie-style Token Usage Overview (`今日` / `7 天` / `30 天` / `全部`).
- **Complete Todos Schedules System (`SchedulesView.jsx` + `ScheduleModal` + `src/server/schedule-engine.mjs` + 4 Chief MCP Tools)**:
  - Added **`定时任务`** sidebar entry (above `配置中心`), `+ 新建 -> 新建定时`, and `TodoDrawer` header clock button with Todos-style empty state and `新建定时` modal (`每小时` / `每天` / `每周` / `单次`, wall-clock IANA timezone, `跟随任务` Agent selector).
  - Real wall-clock scheduler integrated into `reconcileActiveRuns` (`tickDueSchedules`), enforcing Todos semantics (50-rule cap, no backfill of missed cycles, cycle overrides stale runs, deliberate skip logging for closed/unassigned todos, 1-minute retry for one-shot rules) and 4 new Chief MCP tools (`list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`, bringing total MCP tools to **31**).

## [0.7.0] - 2026-11-23

### Added
- **Serialized Chief Message & Wake Queue (`topic_queue` + `ot-queue-tray`, Todos `中途插话` pattern)**:
  - Sending a new message while Chief is still executing its previous turn no longer fires a second concurrent run; it cleanly enters the topic's persistent SQLite queue (`topic_queue`), rendered above the composer with **撤回 (`cancel-topic-queue-item`)** and **立即执行 (`promote-topic-queue-item`)** actions, and auto-drains in strict FIFO order the instant the current turn ends.
  - Automated `maybeWakeChief` task-completion wakes that arrive while Chief is busy are also persisted in `topic_queue` (and coalesced if multiple tasks finish together) instead of being dropped — eliminating silent stalls in complex multi-task pipelines.
- **4-Layer Hard Constraint for Chief Pure Orchestration (`settings.chiefStrictOrchestration`, default ON)**:
  - **Layer 1 (Physical Workspace Isolation)**: Chief sessions run exclusively inside `<dataDir>/chief-workspace` (zero project source code, zero `.git`), never inside a project's `repoPath`.
  - **Layer 2 (Read-Only Repo Inspection MCP Tool #27 `inspect_project_repo`)**: Lets Chief inspect branches, unmerged commits, working-tree status, recent log, and `AGENTS.md`/`CLAUDE.md` without opening a shell in any repository.
  - **Layer 3 (Real-Time Violation Audit)**: Detects direct mutating tool calls (`write_file`/`patch`/mutating repo `terminal`) during Chief turns and posts an explicit governance alert.
  - **Layer 4 (Post-Turn Repo Fingerprint Audit)**: Snapshots registered project `HEAD` + `git status` pre/post-turn to flag any direct main-checkout mutation outside `merge_build`.
- **Complex-Task Engine Hardening (Absorbed from Todos & Multica)**:
  - **Worktree Dependency Auto-Bootstrap (`bootstrapWorktreeDependencies`)**: Automatically symlinks gitignored local dependencies (`.venv`, `backend/.venv`, `node_modules`, `frontend/node_modules`, `.env`, etc.) from the main repo into isolated worktrees so project test suites (`./scripts/test.sh`, `pytest`, `npm test`) pass out of the box, and safely unlinks ONLY recorded symlinks before removing worktrees (plus stale `index.lock` auto-healing).
  - **`queued` (`排队中`) Phase & Automatic Slot Drain (`drainQueuedTodos`)**: Exceeding `maxConcurrentBuilds` parks additional todos cleanly in `queued` instead of throwing an error, and automatically launches them the moment any running build parks at a gate or settles.
  - **Live Worker Progress Sync & Stuck `merging` Crash Recovery**: Streams live Worker progress into `TodoDrawer` while running and auto-recovers interrupted `merging` todos after host restarts.
- **Unified Todos-Style「+ 新建」Dropdown Menu**: Consolidated topic, task, project, and Agent creation into one crisp warm-paper `+ 新建` menu at the top of the sidebar.
- **High-Impact Branded Boot Splash (`BootSplash`), Welcome Hero & Instant Window-Switch Startup**:
  - Added `localStorage` stale-while-revalidate boot cache (`ekko_todo_boot_cache_v1`) + non-blocking cold `getSnapshot` runtime warming so returning from another Studio window renders in `< 25 ms` (and cold RPC drops from ~700ms to `< 10ms`).
  - Replaced bare `正在加载 Ekko ToDo…` text with an adaptive light/dark branded splash screen and upgraded the empty-topic welcome hero.

### Fixed
- **Mixed Chinese/English IME Composition Bug (`isImeComposingEvent`)**: Wired full `compositionstart` / `compositionend` + `isComposing` + `keyCode === 229` + 120ms WebKit post-composition guard and post-submit DOM value flush across the composer and every Enter-submitting input, completely eliminating premature sends and lingering English characters in macOS Chinese IMEs.

## [0.6.0] - 2026-11-23

### Fixed
- **Root-Cause Fix for Premature Settlement & Chief Session Desync**:
  - Diagnosed why `reconcileActiveRuns()` was falsely marking active builds, reviews, and Chief runs finished within seconds: Studio's `GET /api/studio/sessions/:id` does not return an `is_running` boolean. Replaced with authoritative live socket `resumed.isWorking` probing (`probeSessionWorking`) and fail-closed HTTP fallback so active runs are NEVER prematurely settled.
  - Subscribed `handleHostEvent()` to the complete `chat.*` lifecycle (`chat.run.queued`, `chat.run.started`, `chat.tool.started/completed/failed`, `chat.message.created`, `chat.run.completed/failed/stopped`) and upgraded `syncChiefTranscript()` to bidirectionally sync BOTH user and assistant messages from external Studio Web-UI turns without clearing `isRunning` mid-run.
  - Upgraded client `App.jsx` live stream handler to read `resumed.isWorking`, `runStartedAt`, and replay buffered `events`, plus auto-sync via `sync-topic-session` on topic switch and tab return — runs started in Web-UI immediately show live running status inside Ekko ToDo.
  - Hardened `parseReviewVerdict()` to fail-closed (`changes_requested`) on empty output instead of defaulting to `approved`.
- **Idempotent, Non-Blocking Merge with `merging` Phase & Zero Duplicate Commands**:
  - Added `'merging'` phase to XState v5 `todoMachine` (`review -> merging -> done/failed`), mapped directly to the Kanban **`执行中`** column. Clicking **`批准并合并`** immediately locks re-entry (`mergingTodos`), transitions the card into **`执行中`** with an animated running strip, returns without UI lag, and settles cleanly to **`已完成`** on completion.
  - Eliminated the 120-second self-deadlock and duplicate wake commands when Chief invokes MCP `merge_build` (`caller: 'chief'` skips re-queuing a run into Chief's own active session; terminal merge wakes deduplicate on `wake:<todoId>:merged`).
- **Removed Artificial 100-Turn Cap (`0` = Unlimited / Inherit Engine Default, Up to 2000)**:
  - Raised Agent `maxTurns` ceiling from `100` to **`0`（不限 / 直接继承底层引擎上限，如本机 Hermes 默认 500 轮）或 `1–2000` 手动上限**, wired `max_turns` cleanly when explicitly set, and added quick-pick presets (`不限 / 100 / 300 / 500 / 1000`) in Agent Manager.

### Added
- **Web-UI Session Isolation (`category` / `hidden` / `default`)**: Added native Ekko Studio session category assignment (`POST /api/studio/session-categories` + `POST /api/studio/sessions/:id/category`) and optional auto-archive hiding (`hidden`) in Settings → 运行环境, plus a one-click **`立即整理已有会话`** (`sync-session-isolation`) action so Ekko ToDo sessions no longer clutter the main Web-UI session list.
- **Humanized Fresh Notion-Style Random Avatars & Warm-Paper「更换头像」Modal (`AvatarKit.jsx`)**: Replaced icon-style Agent badges with bundled `@dicebear/notionists` hand-drawn B&W portraits on 8 fresh pastel circular backgrounds (millions of non-repeating combinations via `notion:<seed>`), featuring a warm-paper **`更换头像`** 9-grid modal with **`换一批`** and size/MIME-enforced **`上传照片`** (`PNG / JPG / WebP`, `≤ 2 MB`, 1:1 `128×128`, blocking SVG XSS).
- **Clear Live Running Status Bars (Chief + Kanban Cards + Drawer + Sidebar)**: Added pinned top Chief running banner with pulsing avatar ring, live tool name/count, ticking elapsed clock, indeterminate progress bar, and stop button; embedded animated running status strips inside every `building` / `reviewing` / `merging` Kanban card and `TodoDrawer` header; added `运行中` badges to active sidebar topics.
- **Default Chief Recommendation Pre-Fill in Approvals**: Extended `update_topic_brief` (`waiting_recommendation`) and `ask_user` (`recommendation`) plus smart natural-language extraction (`resolveChiefRecommendation`) so `TopicDecisionDialog`, inline Topic Brief approval, and task question cards automatically pre-select Chief's recommended option and pre-fill Chief's concrete suggestion for one-click approval (and fixed awkward 72-char mid-word truncation).

## [0.5.0] - 2026-11-23

### Added
- **Universal First-Run Onboarding Wizard (`OnboardingWizard.jsx`)**: Brand-new users are guided through a 3-step setup that works for **any primary engine** (never locking users to Hermes — supports Claude Code, Codex, Grok, DeepSeek, Qwen Code, Cursor, or Hermes as the primary Chief with optional failover engine & model picker), offers 4 cross-domain team templates (**软件研发团队 / 新媒体与内容团队 / 产品与研究分析 / 个人全能助理**), and makes GitHub/project linking completely optional. Always re-openable from Settings (`运行环境`) or `⌘K`.
- **Complete New-User GitHub Authorization Flow (`GithubAuthCard.jsx` & `git-engine.mjs`)**: Supports both guided **GitHub OAuth Device Login** (`gh auth login --web` with one-time 8-char code capture, one-click copy & browser launch, and live polling) AND zero-CLI **GitHub Personal Access Token (PAT)** authentication via GitHub REST API (stored strictly server-side per profile, never echoed to UI or `.git/config`), plus account switching/logout and zero-auth public URL / local directory workflows.
- **Project Display Aliases (`displayName`) & Avatars**: Projects support human-friendly display aliases (e.g. showing a Chinese alias alongside the English GitHub repo slug) at import/creation time and in Settings (`编辑别称/头像`), plus custom avatar upload or 6-color monogram fallback derived from the first character of the display alias.
- **Agent & Project Avatar System with Enforced Upload Specification (`AvatarKit.jsx` & `avatars.mjs`)**: 10 built-in vector Agent avatar presets + custom raster upload (`PNG / JPG / WebP`, `<= 2 MB`, client-side 1:1 square center-crop & compression to `128×128`, strict server-side MIME & size validation rejecting SVG XSS). Rendered consistently across Sidebar, Kanban cards, Agent Manager, Chief chat, Quick Chief Popover, Todo Drawer, and `@Agent` mention picker.
- **Flexible Custom Agent Roles &「让大总管帮我创建」**: Decoupled execution capability (`chief / builder / reviewer / qa / custom`) from free-form **`roleLabel`** with 11 cross-domain preset chips (including 新媒体运营、内容主编、选题策划、视觉设计、数据分析、深度调研、产品策划、通用助理). Added a prominent **`让大总管帮我创建`** button in Agent Manager that immediately opens a guided Chief conversation to configure a tailored Agent via MCP `configure_agent`.
- **Fixed Optimal Kanban Column Width, Todos 9-Dimension Filter Popover, Fullscreen & Mobile Gestures**:
  - Locked Kanban columns to an optimal `276px` readable width with smooth horizontal scrolling (stretching gracefully in fullscreen mode with a `← 返回对话` button).
  - Implemented the Todos-style 9-dimension drill-down filter popover (`创建者 / 等谁确认 / 阶段 / 项目 / Agent / 话题 / 类型 / 方案与变更 / 标签与关键词`) with active filter chips and one-click reset, plus paper-style 5-item topic action menu (`重命名话题 / 置顶话题 / 复制链接 / 归档话题 / 删除话题`).
  - Upgraded mobile (`<= 780px`) UX: portrait defaults to Chief chat, horizontal swipe switches between Chat and Kanban, and tapping any task/decision opens a full-screen view with a top-left **`← 返回`** button.
- **Chief Chat All-Format File Upload (Hermes-WebUI Standard) & `@Agent` Mentions**:
  - Supports uploading any mainstream file up to **50 MB** (images, code, PDF/Office documents, audio/video media, archives) via button click, OS drag-and-drop, or `Cmd+V` clipboard paste — prioritizing native Hermes-WebUI `/api/studio/uploads` with automatic fallback to `upload-chat-file` RPC, persisted in `topic_messages.attachments_json`, and forwarded using Hermes-WebUI's exact multimodal array & `[Attached image/file]` path contract.
  - Typing `@` (or clicking `@`) opens a keyboard-navigable Agent mention popover with avatars and custom roles; backend resolves `@Agent` mentions and injects structured routing context into Chief's turn.

### Fixed
- **Unmodifiable `最大并发构建槽位` Slider**: Fixed the missing `onValueChange` controlled handler on Radix `<Slider.Root>` in `SettingsPanel.jsx`, and enhanced it with `-` / `+` stepper controls and clickable `1–8` preset ticks.
- **Settings UX Audit Fixes**: Replaced per-keystroke RPC firing on `defaultCloneRoot` with buffered local draft + save button, added two-step delete confirmation for projects, and replaced developer-centric jargon with accessible user copy across empty states and forms.

## [0.4.0] - 2026-11-23

### Added
- **Distinctive Brand Identity (`assets/logo.png` & `BrandLogo.jsx`)**: Redesigned the plugin navigation & Plugin Center icon blending Todos architectural `[ ]` bracket precision with Multica's bold geometric squircle readability, featuring a high-contrast electric sky-blue checkmark engineered for 17px–128px clarity in both light and dark Studio themes.
- **Topic-Brief ↔ Kanban「待你处理」Approval Loop**:
  - Any active topic carrying `brief.waitingOnYou` now automatically surfaces as a pulsing amber **`待你批复`** decision card pinned at the top of the Kanban **`待你处理`** column and counts toward project & board attention badges (`counts.waitingTopics` + `counts.humanAttention`).
  - Added dedicated **`TopicDecisionDialog`** and upgraded the inline **`TopicBriefCard`** waiting row with clickable option chips (supporting explicit `waiting_options` from `update_topic_brief` / topic-level `ask_user` as well as safe extraction for natural Chinese `是…还是…` binary choices), free-text approval input, and one-click structured **`【批复确认】`** submission that immediately wakes the Chief to proceed.
  - Extended `ask_user` MCP tool to support topic-level decisions via `topic_id` (even before any todo exists) and extended `update_topic_brief` with `waiting_title` and `waiting_options`.
- **Todos-Grade Shared-Layout Card Motion & Full Lifecycle Visual States**:
  - Upgraded `motion/react` `LazyMotion` from `domAnimation` to **`domMax`** with **`<LayoutGroup>` + `layoutId`** so cards physically spring out of their previous column (e.g. `待你处理` → `执行中` → `已完成`) and emit a semantic landing halo pulse on arrival.
  - Added hardware-accelerated top luminous progress sweep (`.ot-card-shimmer`), live ticking elapsed duration clock, responsible agent badge, and distinct semantic phase styling across `待派发`, `规划方案中`, `编码构建中`, `独立审查中`, `方案就绪 · 待你批准`, `构建完毕 · 测试通过`, `审查通过 · 待你合并`, `执行失败 · 可重试`, and `已合并完成`.

## [0.3.0] - 2026-11-23

### Added
- **Primary/Fallback Model Chains & Automatic Failover**: Every Agent now carries up to 8 ordered run configurations (`modelConfigs`: 1 primary + up to 7 fallbacks, each with its own engine, catalog/custom model, Wire API mode, and reasoning effort slider) plus an `autoFallback` switch. Built a Todos-grade model fault classifier (`src/server/failover.mjs`) that automatically switches to the next healthy fallback config on quota/rate-limit/auth/5xx/network/incompatible-param faults while skipping configs in 1-hour cooldown (`config_cooldowns`), and never switching on user aborts, git conflicts, or test failures.
- **Zero-Modal Topics, Automatic Model Title Generation & Topic Brief**: Clicking `+ 新建话题` opens an instant clean topic and focuses the composer with zero modal dialog. On the first user message, an asynchronous background model call (`src/server/title-generator.mjs`) generates a concise topic title without adding chat latency (never overwriting manually renamed topics). Added inline double-click rename, pin/archive/delete menu, and a Todos-style collapsible **Topic Brief** (`目标 / 当前 / 下一步 / 等你 / 卡住`) with one-click `已处理并通知总管`.
- **Software-Engineering Master-Detail Agent Manager & Chief Charter**: Replaced legacy roster wording/layout with a clean two-column **Agent 管理** workspace featuring inline primary/fallback chain reordering (`设为首选` / 上移 / 下移 / 冷却清除), plus a Todos-aligned **总管章程 (Standing Charter)** layer injected every Chief turn and automatic repository `AGENTS.md` / `CLAUDE.md` loading into worker runs.
- **Todos-Grade Workbench Interactions & Shortcuts**: Added draggable vertical split resizing (persisted per device), drag-and-drop Kanban cards directly into the Chief composer as `#number` reference chips, collapsible Kanban columns, `待你处理` human-first sorting with `+N` Chief-tracked summary, explicit reversible `failed` phase (`原地继续重试` / `从头重跑`), and full keyboard shortcuts (`⌘K`, `⌘,`, `⌘B`, `⌘⌥B`, `⌘⇧↵`, `⌥↑/↓`).
- **26 MCP Tools**: Added `rename_topic` and `update_topic_brief`, and extended `configure_agent`, `configure_chief`, and `run_build` with `model_configs`, `auto_fallback`, `charter`, `config_id`, and `fresh`.

### Fixed
- **Blank White Sidebar Drawer on Mobile & Narrow Viewports**: Scoped responsive hiding strictly to `.ot-workbench > .ot-left` so opening the sidebar drawer (`<= 980px` and `<= 780px`) always renders the complete populated sidebar; exposed sidebar toggle cleanly on 781px–980px tablets/narrow windows.

## [0.2.0] - 2026-11-23

### Added
- **Custom Model & Dynamic Reasoning Effort Slider**: Every agent role supports both live per-engine Studio model catalog selection and full custom model configuration (`provider`, `model`, `apiMode`, optional `baseUrl`), paired with a tactile Radix UI `ReasoningSlider` dynamically adapting to each model's supported `reasoningEfforts` (`default` through `ultra`), plus sandbox mode, approval policy, max turns, and memory switches.
- **GitHub Import & Local Directory Binding**: Two-mode project importer (`从 GitHub 导入` + `本地 Git 仓库`) supporting `gh` CLI repository search/browse, direct `owner/repo` / HTTPS / SSH URL input, associating with an existing local Git directory, or cloning directly into a chosen local parent directory; automatically detects `origin` GitHub remotes for local repositories.
- **Chief Super-Admin Authority & Structured Memory Store**: Expanded the `ekko-todo` MCP server from 16 to **24 tools** (`get_system_config`, `configure_chief`, `configure_agent`, `delete_agent`, `configure_project`, `import_github_project`, `list_memories`, `manage_memory`) governed by an explicit 6-switch Chief authority matrix, structured SQLite `memories` (`chief` / `project` / `agent` scopes with categories & pinning), and an optional read-only host Hermes memory reference bridge.
- **Quick Chief Config Popover & `⌘K` Command Palette**: Adjust Chief role, model, thinking slider, memory injection, and authority switches directly from the chat composer bar, or press `⌘K` / `Ctrl+K` (`cmdk`) for instant navigation and thinking-level switches.
- **Performance, Streaming & Motion Refinements**: RAF-batched real-time session streaming (`message.delta`, `reasoning.delta` collapsible thinking accordion, `tool.started`/`tool.completed` live pills, `usage.updated` token counter), visibility-aware adaptive polling with state fingerprinting, memoized board/sidebar/message subtrees, and subtle `motion/react` (`LazyMotion`) transitions respecting `prefers-reduced-motion`.
- **Chinese Localized Agent Roster**: Default roles localized cleanly (`大总管`, `核心主程`, `独立审查员`) with automatic non-destructive migration for untouched v0.1.0 databases.

## [0.1.0] - 2026-11-23

### Added
- Official Ekko Studio Plugin SDK v1 manifest (`ekko-todo`) with 12-locale `i18n`, dedicated `ekko-todo` MCP server, `slot: "page"` unified workbench, and `slot: "settings"` configuration view.
- Durable `node:sqlite` (WAL) persistence layer scoped by `(userId, profile)` in `ctx.paths.dataDir`.
- XState v5 deterministic todo lifecycle statechart (`todo -> confirm / building -> reviewing -> review -> done / closed`).
- Isolated Git worktree manager (`simple-git`) with shadow `GIT_INDEX_FILE` snapshots, unified Diff parser, and conflict-safe merge + cleanup.
- Zero-token deterministic pre-gate test runner (`gate-runner.mjs`).
- Multi-engine session orchestrator via `ctx.host.sessions.*`, 16 MCP tools, `watch_todos` idempotent Chief wake loop, `ctx.events.on('chat.*')` handler, and `ctx.scheduler.every` crash-safe reconciler.
- Minimalist 3-column Todos-aligned UI built with React 19, Radix UI, Phosphor Icons, Marked, and DOMPurify with automatic Ekko Studio light/dark theme synchronization.
- Self-contained dual esbuild bundles (`dist/server.mjs`, `dist/client.mjs`) requiring zero runtime `node_modules`.

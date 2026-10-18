# Larkling

Larkling 是跑在飞书里的个人助手运行时。一个进程只服务一个 bot。渠道和模型运行时都走同一套协议，核心不依赖某一种 IM 或某一种 agent。

当前版本包含协议、与渠道无关的核心、任务系统和心跳、内存测试渠道、可脚本化的假运行时、Codex app-server 适配器、pi（`pi --mode rpc`）适配器，以及飞书渠道适配器（含消息归一化）。人的记忆模块只留了接口。消息编辑和 dsh 还没做。

## 布局

```
src/protocol/     协议类型、回复标记、会话种子
src/core/         投递、闸门、会话、任务编排、审批、人物
src/tasks/        本机任务 API 与提示词
src/channels/     memory 与 feishu
src/runtimes/     codex、pi；dsh 仅占位
src/cli/          larkling 命令
```

配置默认读 `LARKLING_CONFIG`，否则是 `~/.larkling/config.yaml`。状态目录默认 `~/.larkling/state`，可用 `LARKLING_STATE_DIR` 覆盖。飞书密钥用 `LARKLING_APP_SECRET`（配置里写 `env:LARKLING_APP_SECRET`）。任务 API 只监听 `127.0.0.1`，地址写在状态目录的 `api.url`，所有者令牌写在 `owner.token`（权限 0600）。示例见 `examples/config.yaml`。

`owner` 写成 `feishu:` 加上你的 `open_id`（`ou_` 开头）。身份只认 `open_id`，不读 `union_id`。`persona.name` 不写时，启动后用飞书应用名称（`/open-apis/bot/v3/info` 的 `app_name`）。群和话题的近期窗口除了条数和 token，还按 `im.window.maxAge` 丢掉更早的消息，默认 24 小时。机器人已经回复过的话题里，之后没 @ 的消息会走相关性判断；某个 scope 在 `respondTo.scopes` 里写了规则时，以配置为准。要停掉后台任务，直接用自然语言说，前台会取消对应任务；对得上不止一个时，会先列出来问你。`agents.front` 和 `agents.back` 都可以写 `fast: true`（默认 `false`）。打开后这一侧的回合走更快的服务档位；检查、相关性判断和压缩用的轻量配置也沿用同一个开关。`network` 默认 `false`。设为 `true` 时，这一侧沙箱里的命令可以访问网络；轻量回合不打开网络。前台工作目录默认是状态目录下的 `front`（也就是 `~/.larkling/state/front`），可以用 `agents.front.cwd` 改掉。前台在 pi 上通过专用工具 `task_start` / `task_update` / `task_get` / `task_cancel` 起停和读写后台任务；后台用 `task_update` / `task_complete`（以及 `task_get`、`im_history`、`im_file`、`person_lookup`、`group_lookup`）。Codex 用同一套 `dynamicTools`。`task/update` 是部分更新：没送到的 `body`、`followUpEnabled`、`audience` 保持原值。受众是 `{ own, drive, track }`，每项是 `{ openId, name }`。`openId` 来自本会话入站或 mention 里出现过的 `ou_…`，或本轮 `person_lookup` 的结果，不得编造。运行时只校验格式。API 地址和会话令牌由进程环境注入。确认文案仍由模型自己写。私聊里用户和机器人的每一条消息都会写入 imlog（群/话题仍按 @、机器人自己的发送、以及已参与话题的规则）。每次 conversation 回合开始前打一条 `turn.prep` 日志，字段有 cold、ensureRuntimeMs、seedMs、openMs、buildTurnMs、historyMs、audioMs、totalMs，用来对冷启动和热启动分段计时。相关性闸门每次决定放行或跳过时打一条 `gate.decision`：`decision` 为 `allow` 或 `skip`。判断用的系统提示是固定英文文件 `src/tasks/prompts/relevance.md`，只在能有用地回答，或这件事明显是在找它（点名、它答得上的问题、或它已经在里面的线程）时才 `RESPOND`，否则 `SKIP`。名字、人设和职责在上下文的 You 里，不写进系统提示。入参是结构化的 Turn input（`recent` 只含更早的消息，`candidates` 是待判断的消息，话题另有 `root`），不再拼信封，也不再把候选正文再贴一遍。输出两行：第一行 `RESPOND` 或 `SKIP`，第二行一句与消息同语言的短理由。`reason` 记这一句；没有这句，或只有 related / off-topic 这类空话时，记 `reason_missing`。短路仍是原因码（`dm`、`mention`、`mention_required`、`bot_sender`、`mentions_others`、`group_read_disabled`、`trust`、`bot_chain`、`self`、`store_only`、`unsupported`、`judge_failed`）。同条还有 `sessionId`、`chatId`、`messageIds`、`mode`、`mentionsSelf`、`senderId`（多名发送者时看 `senderIds`）和 `source`（`judge` 或 `short_circuit`）。进了去抖、还没判断的消息先不打这条。每个 conversation 回合开头给模型一段结构化 JSON（`turn` / `history` / `trigger`）：冷启动拉完整窗口（群会翻页到条数上限），同一前台会话存活期间只按时间增量拉新消息并按消息 id 去重；窗口只来自飞书平台历史，不再并入 imlog。正文里真实的 @ 用飞书写法 `<at user_id="ou_xxx">名字</at>`，以 `mentions` 字段为准。事项的受众记在任务上，不写进每回合的结构化输入。群和话题里，模型在回复末行写 `[[notify <taskId>]]` 时，由运行时按 Own、Drive、Track 插入这些 @；私聊只保留受众、不 @。闲聊不加这一行，也不会把历史里的人拉进 @。当前不支持 @all。模型写的 `<at>` 一律降为普通文本。

本地目录缓存在状态目录的 `directory.json`：人按 `open_id` 存名字和所在群（视为可信，30 天后仍先用旧值、后台刷新），群按 `chat_id` 存群名和最近活跃时间。群名靠订阅飞书事件 `im.chat.updated_v1` 更新（需要在开发者后台订阅该事件），不轮询；第一次见到某个群时调一次 `GET /open-apis/im/v1/chats/:chat_id` 补群名。缓存里找不到人时，按最近活跃顺序每批并发 20 个群拉群成员（走同一个限流器），找到就停，见到的成员都写进缓存。不使用通讯录接口。只有后台能查：pi 上是 `person_lookup` / `group_lookup` 工具，Codex 上是 `larkling person lookup` / `larkling group lookup` 命令，背后都是 `POST /v1/person/lookup`、`POST /v1/group/lookup`。前台不查人，要拉进不在上下文里的人时交给后台。原来的 `im who` 已去掉。

## 信任

入口只决定这条消息能不能进会话，不决定要不要回复。群里仍按 `im.respondTo` 和 Gate 处理：默认要 @，配成 `relevant` 才做相关性判断。`session.botChainLimit` 只截断同一个会话里连续的机器人互聊，不是信任拒绝。

`owner` 在任何会话里都放行。`trust.trusted` 和 `trust.allowed` 合成一份个人白名单，入口规则相同，返回的角色标签仍分开。私聊，以及没有父群的话题，只认所有者和这份白名单。普通群和来自群的话题默认开放：没被点名的人和机器人都是 `allowed`。写进 `trust.restricted` 的 chat id 收紧到个人白名单；话题跟随父群，父群或话题自己的 id 在名单里都算锁住。`restricted` 为空时，所有群都开放。

升级时删掉原来的 `trust.groups`。那个字段是开放群白名单，和现在的含义相反，不要把里面的 chat id 抄进 `trust.restricted`。删掉之后，以前没写进 `groups` 的群也会变成开放；只有确实要锁住的群，才把它的 chat id 写进 `restricted`。配置里再出现 `trust.groups` 会直接被拒绝。

## 命令

```
larkling start [--config file]
larkling status [--config file]
larkling doctor [--config file]
larkling service print systemd|launchd
larkling config validate|schema|print [--config file]
larkling task start|continue|update|get|list|cancel
larkling im history|file
larkling person lookup --open-id <ou_...> | --query <名字> [--scope current|all]
larkling group lookup --chat-id <oc_...> | --query <群名> [--members]
```

`task` 和 `im` 读 `LARKLING_API_URL` 与 `LARKLING_SESSION_TOKEN`，也可以用 `--api` 和 `--token`。

## 跑测试

需要 Node.js 22 或更新。

```bash
npm install
npm test
```

`npm run typecheck` 同时检查源码和测试。测试不连接飞书，也不启动真实的 `codex`。核心路径走内存渠道和脚本化运行时；飞书用例喂的是伪造的事件和 HTTP 响应；Codex 用例走内存里的 JSON-RPC，另有一条标准输入输出的分帧检查。

## 用真实飞书应用手测

自动化测试替换了飞书长连接和开放平台。下面这套是第一次接到真机器人时的手工检查。

1. 在飞书开放平台创建一个企业自建应用，打开机器人能力。
2. 开通权限：`im:message`、`im:message.group_msg`（敏感权限，需要管理员审批）、`im:chat:readonly`、`speech_to_text:speech`。群和话题里的显示名来自 `GET /open-apis/im/v1/chats/:chat_id/members` 的 `items[].name`。`im:chat:readonly` 已经覆盖这个接口；也可以改开更窄的 `im:chat.members:read`。不查通讯录。私聊里如果消息本身没有名字，就保持为空。没有群消息权限时，把配置里的 `readGroupMessages` 留成 `false`。
3. 事件订阅使用长连接，订阅 `im.message.receive_v1`、`im.message.recalled_v1`、`im.message.reaction.created_v1`、`im.message.reaction.deleted_v1`、`card.action.trigger`。不要订阅消息编辑事件，这一版会直接丢掉。
4. 安装依赖并编译。长连接 SDK `@larksuiteoapi/node-sdk` 已经在依赖里，`npm install` 就够，不用再单独装：

   ```bash
   npm install
   npm run build
   ```

5. 把 `examples/config.yaml` 复制到 `~/.larkling/config.yaml`。`owner` 写成 `feishu:` 加上你自己的 `open_id`。`appId` 换成应用的 App ID。模型换成你的 Codex 账号支持的名字，示例里是 `gpt-6.1-sol` 和 `gpt-6-luna`。群默认开放。要锁住某个群，把 chat id 写进 `trust.restricted`。不要再写 `trust.groups`。
6. 导出密钥并检查配置：

   ```bash
   export LARKLING_APP_SECRET='应用的 App Secret'
   node dist/cli/index.js config validate
   node dist/cli/index.js doctor
   node dist/cli/index.js start
   ```

   本机需要有 `codex` 命令，并且支持 `codex app-server`。PATH 上较旧的 `codex` 可能不支持配置里的新模型，把 `runtimes.codex.command` 指到更新的二进制。语音消息还需要 `ffmpeg`。启动日志里如果出现 `bot.open_id_unresolved`，群里的 @ 会被忽略，先核对应用凭证和 `/bot/v3/info`。
7. 在飞书里私聊这个机器人，发一句普通文字，确认有回复。再在已把机器人拉进去的群里 @ 它。很短的纯文本用 `text`。其余回复，包括 Markdown 表格，用富文本 post 的 `md`（post 能渲染表格）。对话回复不发 interactive 卡片。需要批准的操作会在所有者私聊里发一张一次性卡片。群里 @ 机器人时，模型看到的是固定的 `@bot`。要停掉正在跑的后台任务，直接说停哪一件。

真机上仍要核对的地方：`@_all` 的事件形态、语音文件的容器格式、语音识别接口的实际返回字段和租户 QPS、卡片和富文本在客户端里的渲染，以及本机 `codex app-server` 的字段名是否与当前适配器一致。

## pi 运行时

`agents.front.runtime` 和 `agents.back.runtime` 可以分别写 `codex` 或 `pi`，两边可以混用。pi 用的是 `@earendil-works/pi-coding-agent` 1.x（用 https://pi.dev/install.sh 安装；旧的 `@mariozechner/pi-coding-agent` 已不再更新），Larkling 以 `pi --mode rpc` 启动它，按行读写 JSON。

- 每个打开的会话起一个 pi 进程，空闲回收时进程退出。会话文件放在 `runtimes.pi.sessionDir`，默认是状态目录下的 `pi-sessions`（`~/.larkling/state/pi-sessions`），不碰 `~/.pi` 里的会话。检查、相关性判断和压缩用 `--no-session`，不留文件。
- provider 一定要写。pi 自己默认用 google，所以 Larkling 总是显式传 `--provider` 和 `--model`。可以写在 `runtimes.pi.provider`，也可以在 `agents.<front|back>.provider` 单独覆盖。ChatGPT Plus/Pro 订阅对应的 provider 是 `openai-codex`。
- 登录由你自己在终端里跑 `pi`，再执行 `/login`。凭据存在 pi 自己的 `~/.pi/agent/auth.json`，Larkling 不读也不写。
- 内置系统提示词按 FRONT / BACK / HEARTBEAT / RELEVANCE 拆在 `src/tasks/prompts/`。Codex 前台/后台会话通过 app-server `dynamicTools` 暴露与 pi 相同的任务与目录工具。系统提示词用 `--system-prompt` 传入，同时带上 `--no-context-files`、`--no-skills`、`--no-extensions`、`--no-prompt-templates` 和 `--no-themes`，不加载 AGENTS.md、技能和扩展。前台和后台仍会各加载一个 Larkling 工具扩展（`--extension`），检查、相关性判断和压缩不加载。
- 这两个扩展在拉起 pi 之前复制到 `<stateDir>/pi-extensions`，`--extension` 只指向这份副本，pi 冷启动不会去读安装目录。安装目录上的读取若超过 RPC 超时，有上一份副本就用上一份，没有就失败，不会把安装目录路径交给 pi。
- `get_state` 以及其他 RPC 超时后，先对 pi 发 SIGTERM，约 1 秒后仍不退出就 SIGKILL。超时日志记下子进程 stderr，以及实际传给 pi 的扩展路径。
- `effort` 对应 pi 的 `--thinking`：`none` 写成 `off`，`minimal`、`low`、`medium`、`high`、`xhigh` 原样传。认不出的值不传，用 pi 默认值。
- 新会话的历史种子放进第一回合的消息前面。恢复已有会话不再注入。恢复时如果会话文件已经不在，Larkling 会新开一个会话，并重新注入种子。
- 运行中的追加消息走 pi 的 `steer`，打断走 `abort`。工具调用会作为活动事件上报。上下文快满时 pi 自己会压缩，Larkling 的转录压缩照常进行。

pi 没有的东西：

- `fast`：pi 没有服务档位的开关，写了也被忽略。
- `sandbox`、`network`：pi 没有沙箱，bash 工具直接在本机跑，能访问网络，也能写 `cwd` 以外的文件。这两个配置写了不起作用。
- `approvalPolicy`：pi 不发审批请求，命令不会等你批准。后台任务交给 pi 前要想清楚这一点。
- 系统提示词只在进程启动时传入。提示词变了，核心会关掉旧会话，用种子重开一个。

一回合以 `agent_settled` 为准结束：pi 自动重试、溢出后压缩重跑时会先发 `agent_end`，这时还不算完。旧版 pi 没有 `agent_settled`，就在 `agent_end` 结束。pi 1.2.0 自带 `openai-codex/gpt-6-astra`、`openai-codex/gpt-6-luna` 等模型，不需要再写 `~/.pi/agent/models.json`；旧版 pi 才需要参考 `examples/pi-models.json` 手动补模型。

## 这一版没有做的

- 人物记忆：只有 `MemoryStore` 接口，调用会抛出“尚未实现”。
- 消息编辑：收到编辑事件就忽略。
- dsh：配置可以写，真正创建运行时会失败。
- 一个进程一个 bot，没有 `botId`。
- 会话归档（把 180 天前的会话挪走）没做。附件 7 天、消息存档 180 天、已结束或已取消任务 30 天的清理是有的。

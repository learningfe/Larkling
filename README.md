# Larkling

Larkling 是跑在飞书里的个人助手运行时。一个进程只服务一个 bot。渠道和模型运行时都走同一套协议，核心不依赖某一种 IM 或某一种 agent。

当前版本包含协议、与渠道无关的核心、任务系统和心跳、内存测试渠道、可脚本化的假运行时、Codex app-server 适配器，以及飞书渠道适配器（含消息归一化）。人的记忆模块只留了接口。消息编辑、pi、dsh 都还没做。

## 布局

```
src/protocol/     协议类型、回复标记、会话种子
src/core/         投递、闸门、会话、任务编排、审批、人物
src/tasks/        本机任务 API 与提示词
src/channels/     memory 与 feishu
src/runtimes/     codex；pi、dsh 仅占位
src/cli/          larkling 命令
```

配置默认读 `LARKLING_CONFIG`，否则是 `~/.larkling/config.yaml`。状态目录默认 `~/.larkling/state`，可用 `LARKLING_STATE_DIR` 覆盖。飞书密钥用 `LARKLING_APP_SECRET`（配置里写 `env:LARKLING_APP_SECRET`）。任务 API 只监听 `127.0.0.1`，地址写在状态目录的 `api.url`，所有者令牌写在 `owner.token`（权限 0600）。示例见 `examples/config.yaml`。

## 命令

```
larkling start [--config file]
larkling status [--config file]
larkling doctor [--config file]
larkling service print systemd|launchd
larkling config validate|schema|print [--config file]
larkling task start|continue|update|get|list|cancel
larkling im history|file|who
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
2. 开通权限：`im:message`、`im:message.group_msg`（敏感权限，需要管理员审批）、`im:chat:readonly`、`speech_to_text:speech`。没有群消息权限时，把配置里的 `readGroupMessages` 留成 `false`。
3. 事件订阅使用长连接，订阅 `im.message.receive_v1`、`im.message.recalled_v1`、`im.message.reaction.created_v1`、`im.message.reaction.deleted_v1`、`card.action.trigger`。不要订阅消息编辑事件，这一版会直接丢掉。
4. 安装长连接 SDK（运行 `larkling start` 时才需要，测试不需要）：

   ```bash
   npm install @larksuiteoapi/node-sdk
   npm run build
   ```

5. 把 `examples/config.yaml` 复制到 `~/.larkling/config.yaml`。`owner` 写成 `feishu:` 加上你自己的 `union_id`。`appId` 换成应用的 App ID。
6. 导出密钥并检查配置：

   ```bash
   export LARKLING_APP_SECRET='应用的 App Secret'
   node dist/cli/index.js config validate
   node dist/cli/index.js doctor
   node dist/cli/index.js start
   ```

   本机需要有 `codex` 命令，并且支持 `codex app-server`。语音消息还需要 `ffmpeg`。
7. 在飞书里私聊这个机器人，发一句普通文字，确认有回复。再在已把机器人拉进去的群里 @ 它。所有者私聊里发 `/stop` 会打断当前这一轮，不往外发模型的回复。需要批准的操作会在所有者私聊里发一张一次性卡片。

真机上仍要核对的地方：`@_all` 的事件形态、语音文件的容器格式、语音识别接口的实际返回字段和租户 QPS，以及本机 `codex app-server` 的字段名是否与当前适配器一致。

## 这一版没有做的

- 人物记忆：只有 `MemoryStore` 接口，调用会抛出“尚未实现”。
- 消息编辑：收到编辑事件就忽略。
- pi 与 dsh：配置可以写，真正创建运行时会失败。
- 一个进程一个 bot，没有 `botId`。
- 会话归档（把 180 天前的会话挪走）没做。附件 7 天、消息存档 180 天、已结束或已取消任务 30 天的清理是有的。

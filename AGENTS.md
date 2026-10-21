# Agent rules

## Prompts

Each model role has one fixed English system prompt. The runtime reads the file and uses that text as the system prompt.

- `src/tasks/prompts/front.md` — conversation
- `src/tasks/prompts/back.md` — background task
- `src/tasks/prompts/heartbeat.md` — followed-task check (the check role uses this file)
- `src/tasks/prompts/relevance.md` — whether you should speak
- `src/tasks/prompts/compact.md` — transcript summary

Do not build these with TypeScript string templates, mustache slots, or function arguments that rewrite the text. Do not interpolate persona, duty, or name into the system prompt.

Data that changes per turn (turn JSON, recent and candidate messages, task body, now, scope, name, persona, duty) goes in the context payload only. Keep that payload small and structured.

When `agents.front.instructions` or `agents.back.instructions` is set, that operator file is appended after the role file. It is not a template.

## Prompt language

System and instruction prompts are English. User-facing replies, and the one-line relevance reason, follow the language of the user messages. Do not put Chinese or any other non-English text into an English system prompt. Mixing languages biases the model toward that language.

## Model input

Do not stitch chat history into a custom envelope or prose for the model when structured inbound exists (`toTurnMessage` / turn JSON). Pass those fields. Do not use `renderEnvelope` for model input on those paths. `renderEnvelope` is for human-facing history display only.

## Audience

Own、Drive、Track 只决定事项在群和话题里被 @ 的人和顺序。

- Own：主汇报人，这件事原来是谁问的。
- Drive：推动人，@ 机器人来推进或跟进这件事的人。
- Track：关注人，应该被通知的人。

这三份名单不表示取消权、审批权、记忆归属或信任级别。任务原来的 source / owner 语义不变。

只有模型根据对话和用户原话分配角色，例如「叫上小赵」「同步给她」。运行时不冷启动、不补全、不合并、不编造 audience，也不把 audience 写进每一回合的结构化输入。模型要看当前名单时，自己调用 `task_get` 或 `larkling task get`。

工单或链接上的「负责人」可以出现在回复正文里。除非用户明确说「叫上他」或「同步给他」，否则不 @、也不写入 audience。

Audience 存在任务记录上：`{ own, drive, track }`，每项是 `{ openId, name }`。`openId` 必须来自本会话入站消息或 mention 里出现过的飞书 `ou_…`，或者来自模型本轮通过 `person_lookup` 查到的结果，不得编造。运行时只校验 `ou_…` 格式，不核对这个 id 是否在会话里出现过。同一个人只保留最早的角色（Own，然后 Drive，然后 Track）。`task/update` 是部分更新：请求里没有的 `body`、`followUpEnabled`、`audience` 保持原值；`audience` 里没有的角色也保持原值。

群和话题里，模型直接写飞书 `<at user_id="ou_xxx">名字</at>`。需要通知任务受众时，先 `task_get` 读 audience，按 Own、Drive、Track 写这些标签。简单直接的回答也可以 @，不必先开任务。运行时只放行格式合法的 `ou_` openId；`all` 和非法 id 降成普通文本（`@名字` / `@all`）。私聊不渲染真 @，标签降成普通文本。没有 `[[notify]]` 指令。

当前不支持 @all。

入站飞书消息的 `mentions` 若带 nickname 或 name，以及 openId 或 id，按原文 upsert 进人员目录。`mentioned_type: bot` 记 `isBot: true`。缺省 `isBot` 为 false。自己可以不记；其他机器人必须记，`person_lookup` 仍能查到。私聊和开放群不因 `isBot` 拒绝。`trust.restricted` 是按群的允许名单，话题跟随父群。机器人互聊只受 `session.botChainLimit` 限制。

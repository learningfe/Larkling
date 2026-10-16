import type { FeishuChannel } from "./adapter.js";

/**
 * Long connection via the official SDK. Tests ingest events directly and do
 * not open a socket. Message edit events are not registered.
 */
export async function startFeishuSocket(options: { appId: string; appSecret: string; channel: FeishuChannel }): Promise<() => Promise<void>> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      await options.channel.ingest(data);
    },
    "im.message.recalled_v1": async (data) => {
      await options.channel.ingest(data);
    },
    "im.message.reaction.created_v1": async (data) => {
      await options.channel.ingest(data);
    },
    "im.message.reaction.deleted_v1": async (data) => {
      await options.channel.ingest(data);
    },
    "im.chat.updated_v1": async (data) => {
      await options.channel.ingest(data);
    },
    "card.action.trigger": async (data: unknown) => {
      await options.channel.ingest(data);
      return { toast: { type: "info", content: "已记录" } };
    },
  });
  const client = new lark.WSClient({ appId: options.appId, appSecret: options.appSecret });
  await client.start({ eventDispatcher: dispatcher });
  return async () => {
    client.close();
  };
}

export function approvalCard(approvalId: string, summary: string): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "需要你的批准" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: summary } },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "同意" },
            value: { approvalId, decision: "approve" },
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝" },
            value: { approvalId, decision: "deny" },
          },
        ],
      },
    ],
  };
}

/** Feishu uuid is 1–50 chars from [0-9a-zA-Z-]. */
export function feishuUuid(idempotencyKey: string): string {
  const cleaned = idempotencyKey.replace(/[^0-9a-zA-Z-]/g, "");
  if (cleaned.length >= 8 && cleaned.length <= 50) return cleaned;
  return cleaned.slice(0, 50).padEnd(8, "0");
}

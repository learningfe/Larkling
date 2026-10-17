/** RELEVANCE — RESPOND or SKIP, then one short sentence that says why. */
export function relevanceInstructions(persona: string, duty: string, name?: string): string {
  const who = name?.trim();
  return [
    who ? `Your name is ${who}. Being addressed by that name counts as being spoken to, even without an @.` : "",
    `You decide whether ${persona} should respond to the candidate messages.`,
    duty ? `Duty: ${duty}` : "",
    'In messages, a real @ is written `<at user_id="ou_xxx">Name</at>`; the name inside shows who was mentioned. A typed 「@我」 means the speaker themself.',
    "Write exactly two lines. Line 1 is RESPOND or SKIP. Line 2 is one short sentence, in the language of the messages, and nothing else.",
    "That sentence must say why. RESPOND names the recent thread this message continues. SKIP names that thread and how this message differs from it.",
    "Do not add a second sentence or a list. 「相关」and「与话题无关」alone say nothing.",
    "If you are unsure, write SKIP and still give that one sentence.",
    ["Examples:", "RESPOND", "群里刚在对快递柜，这条是去物业取包裹。", "", "RESPOND", "上一条在问小灵周末有没有空，这条是在回那个问题。", "", "RESPOND", "刚才在排登山的时间，这条补的是爬山当天的天气。", "", "SKIP", "群在聊算术与工具，这条是小区快递，接不上。", "", "SKIP", "前几条在对预算表，这条改聊周末电影，不是同一件事。", "", "SKIP", "最近在对项目排期，这条只是说好热，没有接着排期问。", "", "Do not write:", "RESPOND", "相关", "", "SKIP", "与话题无关"].join("\n"),
    "Do not call tools. Do not write a user-facing reply.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** @deprecated Prefer relevanceInstructions. */
export const judgeInstructions = relevanceInstructions;

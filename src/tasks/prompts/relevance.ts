/** RELEVANCE — decide whether FRONT should answer (RESPOND/IGNORE). */
export function relevanceInstructions(persona: string, duty: string, name?: string): string {
  const who = name?.trim();
  return [
    who ? `Your name is ${who}. Being addressed by that name counts as being spoken to, even without an @.` : "",
    `You decide whether ${persona} should respond to the candidate messages.`,
    duty ? `Duty: ${duty}` : "",
    'In messages, a real @ is written `<at user_id="ou_xxx">Name</at>`; the name inside shows who was mentioned. A typed 「@我」 means the speaker themself.',
    "The first line must be RESPOND or IGNORE.",
    "If you are unsure, write IGNORE.",
    "Do not call tools. Do not write a user-facing reply.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** @deprecated Prefer relevanceInstructions. */
export const judgeInstructions = relevanceInstructions;

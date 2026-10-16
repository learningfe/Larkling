export function compactInstructions(): string {
  return [
    "Summarize the conversation so another assistant can continue it.",
    "Keep decisions, names, open tasks, and constraints.",
    "Do not call tools. Do not address the user.",
  ].join("\n");
}

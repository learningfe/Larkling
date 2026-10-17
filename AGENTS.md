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

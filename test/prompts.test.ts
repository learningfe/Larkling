import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backInstructions, frontInstructions, heartbeatInstructions, judgeInstructions, readPrompt, relevanceInstructions } from "../src/tasks/prompts.js";
import { commandsBlock, judgeContext } from "../src/core/context.js";
import type { TurnMessage } from "../src/core/turninput.js";

const han = /\p{Script=Han}/u;

describe("built-in prompts", () => {
  it("reads each role from its markdown file with no persona slots", () => {
    for (const name of ["front", "back", "heartbeat", "relevance", "compact"] as const) {
      const file = readFileSync(new URL(`../src/tasks/prompts/${name}.md`, import.meta.url), "utf8").trim();
      expect(readPrompt(name)).toBe(file);
      expect(file).not.toMatch(/\$\{|\{persona\}|\{duty\}|\{name\}/);
      expect(file).not.toMatch(han);
    }
    expect(frontInstructions()).toBe(readPrompt("front"));
    expect(backInstructions()).toBe(readPrompt("back"));
    expect(heartbeatInstructions()).toBe(readPrompt("heartbeat"));
    expect(relevanceInstructions()).toBe(readPrompt("relevance"));
    expect(judgeInstructions()).toBe(relevanceInstructions());
  });

  it("tells the front agent how to work without baking in a name", () => {
    const text = frontInstructions();
    expect(text).toContain("under You");
    expect(text).not.toContain("Your name is");
    expect(text).toContain("task_start");
    expect(text).toContain("task_update");
    expect(text).toContain("task_get");
    expect(text).toContain("task_cancel");
    expect(text).toContain("Alice is Own, Bob is Drive, Carol is Track");
    expect(text).toContain("[[notify <taskId>]]");
    expect(text).toContain("still write the user-facing confirmation yourself");
    expect(text).toContain("Do not inspect source code, help output, or the file system");
    expect(text).toContain("say in plain words that you will look into it");
    expect(text).toContain("Do not open with stiff wording");
    expect(text).toContain("not yet verified");
    expect(text).toContain("Do not expose how you work");
    expect(text).toContain("Who was really @-mentioned is given by `mentions`");
    expect(text).toContain('<at user_id="ou_xxx">Name</at>');
    expect(text).toContain("@all is not supported");
    expect(text).toContain("Do not invent an open_id");
    expect(text).not.toContain("@bot");
    expect(text).toContain("Never claim to have done an action you did not actually perform");
    expect(text).not.toContain("I created a task");
    expect(text).not.toContain("/stop");
    expect(text.toLowerCase()).not.toContain("bash");
    expect(text).not.toContain("task cancel command");
    expect(text).toContain("bring in Sam");
    expect(text).not.toMatch(/person_lookup|who command/);
  });

  it("names back tools without mentioning bash or the CLI", () => {
    const text = backInstructions();
    expect(text).toContain("task_update");
    expect(text).toContain("task_complete");
    expect(text).toContain("Alice asked, so she is Own");
    expect(text).toContain("Carol is Track");
    expect(text).toContain("im_history");
    expect(text).toContain("im_file");
    expect(text).toContain("person_lookup");
    expect(text).toContain("group_lookup");
    expect(text).toContain("ask the user which one");
    expect(text).toContain("returned by person_lookup in this turn");
    expect(text).toContain("@all is not supported");
    expect(text.toLowerCase()).not.toContain("bash");
    expect(text).not.toContain("larkling ");
    expect(text).not.toContain("Your name is");
  });

  it("states the participation rule in English, with six one-line examples", () => {
    const text = relevanceInstructions();
    expect(text).toContain("## Background");
    expect(text).toContain("## Your job");
    expect(text).toContain("## How to do it");
    expect(text).toContain("## Examples");
    expect(text).toContain("sender.isSelf: true");
    expect(text).toContain("under You");
    expect(text).toContain("even without an @");
    expect(text).toContain("usefully answer");
    expect(text).toContain("thread you were already in");
    expect(text).not.toContain("the bot");
    expect(text).toContain("RESPOND");
    expect(text).toContain("SKIP");
    expect(text).toContain("one short sentence");
    expect(text).toContain("same language as the messages");
    expect(text).toContain("off-topic");
    for (const example of [
      "Sam asked you what time the meeting is, and you can answer that.",
      "You already replied in this thread about the budget, and this message asks you to adjust the same numbers.",
      "They asked how to convert 3 miles to kilometers, which you can answer directly.",
      "Pat and Sam are trading weekend plans with each other, and nobody asked you anything.",
      "They are debugging a deploy you were never in, and you have nothing useful to add.",
      "Your coworkers are planning their own trip, and the messages are not aimed at you.",
    ]) {
      expect(text).toContain(example);
    }
    expect(heartbeatInstructions()).toContain("WAKE");
    expect(heartbeatInstructions()).toContain("Do not assign Own, Drive, or Track");
  });
});

describe("judge context", () => {
  it("passes You plus structured turn messages and does not render an envelope", () => {
    const message = (id: string, body: string, isSelf = false): TurnMessage => ({
      messageId: id,
      sender: { openId: "ou_x", name: isSelf ? "Larkling" : "Sam", isSelf },
      at: "10:00:00",
      mentions: [],
      body,
    });
    const text = judgeContext({
      you: { name: "Larkling", persona: "a personal assistant", duty: "help the owner" },
      recent: [message("old", "earlier")],
      candidates: [message("new", "hello")],
      root: message("root", "topic"),
    });
    expect(text).toContain('"name": "Larkling"');
    expect(text).toContain('"persona": "a personal assistant"');
    expect(text).toContain('"duty": "help the owner"');
    const payload = JSON.parse(text.slice(text.indexOf("Turn input:\n") + "Turn input:\n".length));
    expect(payload.recent.map((item: TurnMessage) => item.messageId)).toEqual(["old"]);
    expect(payload.candidates[0]).toMatchObject({ messageId: "new", body: "hello", sender: { isSelf: false } });
    expect(payload.root.messageId).toBe("root");
    expect(text).not.toContain("Persona:");
    expect(text).not.toContain("Duty:");
    expect(text).not.toMatch(/\[我 /);
    expect(text).not.toContain("#old]");
  });
});

describe("commandsBlock", () => {
  it("omits start and cancel for the front when dedicated tools are enabled", () => {
    const withTools = commandsBlock({
      cli: ["larkling"],
      apiUrl: "http://127.0.0.1:9",
      token: "tok",
      container: "ou_x",
      role: "front",
      frontTaskTools: true,
    });
    expect(withTools).not.toContain("task start");
    expect(withTools).not.toContain("task cancel");
    expect(withTools).toContain("task continue");
    const without = commandsBlock({
      cli: ["larkling"],
      apiUrl: "http://127.0.0.1:9",
      token: "tok",
      container: "ou_x",
      role: "front",
    });
    expect(without).toContain("task start");
    expect(without).toContain("task cancel");
  });
});


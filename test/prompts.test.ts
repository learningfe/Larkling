import { describe, expect, it } from "vitest";
import { backInstructions, frontInstructions, heartbeatInstructions, judgeInstructions, relevanceInstructions } from "../src/tasks/prompts.js";
import { commandsBlock } from "../src/core/context.js";

describe("built-in prompts", () => {
  it("tells the front agent its name, task_start for research, and keeps mechanics private", () => {
    const text = frontInstructions("a personal assistant", "help at home", "小灵");
    expect(text).toContain("Your name is 小灵");
    expect(text).toContain("task_start");
    expect(text).toContain("task_cancel");
    expect(text).toContain("still write the user-facing confirmation yourself");
    expect(text).toContain("Do not inspect source code, help output, or the file system");
    expect(text).toContain("say in plain words that you will look into it");
    expect(text).toContain("Do not open with stiff wording");
    expect(text).toContain("not yet verified");
    expect(text).toContain("Do not expose how you work");
    expect(text).toContain("Who was really @-mentioned is given by `mentions`");
    expect(text).toContain('<at user_id="ou_xxx">Name</at>');
    expect(text).not.toContain("@bot");
    expect(text).toContain("Never claim to have done an action you did not actually perform");
    expect(text).not.toContain("I created a task");
    expect(text).not.toContain("/stop");
    expect(text.toLowerCase()).not.toContain("bash");
    expect(text).not.toContain("task cancel command");
  });

  it("names back tools without mentioning bash or the CLI", () => {
    const text = backInstructions("a personal assistant", "help at home");
    expect(text).toContain("task_update");
    expect(text).toContain("task_complete");
    expect(text).toContain("im_history");
    expect(text).toContain("im_file");
    expect(text.toLowerCase()).not.toContain("bash");
    expect(text).not.toContain("larkling ");
  });

  it("counts a name without an @ as being spoken to", () => {
    const text = judgeInstructions("a personal assistant", "", "小灵");
    expect(text).toContain("Your name is 小灵");
    expect(text).toContain("even without an @");
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

describe("directory prompts", async () => {
  const { frontInstructions, backInstructions } = await import("../src/tasks/prompts.js");
  it("gives lookups to back only", () => {
    const front = (frontInstructions as (...a: unknown[]) => string)("p", "", "bot");
    const back = backInstructions("p", "");
    expect(front).not.toMatch(/person_lookup|who command/);
    expect(front).toContain("叫上小赵");
    expect(back).toContain("person_lookup");
    expect(back).toContain("group_lookup");
    expect(back).toContain("ask the user which one");
  });
});

describe("prompt roles FRONT/BACK/HEARTBEAT/RELEVANCE", () => {
  it("exports HEARTBEAT and RELEVANCE aliases", () => {
    expect(heartbeatInstructions()).toContain("WAKE");
    expect(relevanceInstructions("p", "", "小灵")).toContain("RESPOND");
    expect(judgeInstructions("p", "", "小灵")).toContain("RESPOND");
  });
});

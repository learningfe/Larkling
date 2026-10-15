import { describe, expect, it } from "vitest";
import { frontInstructions, judgeInstructions } from "../src/tasks/prompts.js";

describe("built-in prompts", () => {
  it("tells the front agent its name and keeps mechanics private", () => {
    const text = frontInstructions("a personal assistant", "help at home", "小灵");
    expect(text).toContain("Your name is 小灵");
    expect(text).toContain("larkling task cancel");
    expect(text).toContain("Do not expose how you work");
    expect(text).toContain("Never claim to have done an action you did not actually perform");
    expect(text).not.toContain("I created a task");
    expect(text).not.toContain("/stop");
  });

  it("counts a name without an @ as being spoken to", () => {
    const text = judgeInstructions("a personal assistant", "", "小灵");
    expect(text).toContain("Your name is 小灵");
    expect(text).toContain("even without an @");
  });
});
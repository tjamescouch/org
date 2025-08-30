import { describe, test, expect } from "bun:test";
import { FinalChannelPass } from "../../src/filters/passes/final-channel-pass";

describe("FinalChannelPass", () => {
  test("extracts payload from final/message", () => {
    const p = new FinalChannelPass();
    const input =
      `text\n` +
      `<|channel|>final <|constrain|>@user<|message|>Sure, 2.\n` +
      `<|channel|>final <|constrain|>@user<|message|>Sure, 2.\n`;
    const out = p.feed(input) + p.flush();
    expect(out).toBe("text\nSure, 2.\nSure, 2.\n");
  });

  test("unwraps commentary JSON/echo", () => {
    const p = new FinalChannelPass();
    const a = `<|channel|>final <|constrain|>:/commentary<|message|>{"ok":true,"stdout":"@@user Just repeat my prompts.\\n"}\n`;
    const b = `<|channel|>final <|constrain|>:/commentary<|message|>echo '@@user Here is another one.'\n`;
    expect(p.feed(a)).toBe("@@user Just repeat my prompts.\n");
    expect(p.feed(b)).toBe("@@user Here is another one.'\n".replace(/'$/, "")); // trimmed by regex
  });

  test("stream-safe: partial tags carried", () => {
    const p = new FinalChannelPass();
    const out = p.feed("<|chan") + p.feed("nel|>final <|constrain|>@user<|mes") +
                p.feed("sage|>Sure, 2.\n") + p.flush();
    expect(out).toBe("Sure, 2.\n");
  });
});

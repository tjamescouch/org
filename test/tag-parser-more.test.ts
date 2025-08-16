import { test, expect } from "bun:test";
import { TagParser } from "../src/tools/tools/tag-parser";

test("parses #file + @bob + @group with ordered content slices", () => {
  const input = `#file:notes.md
First para

@bob ping you
@group back to channel.`;

  const { clean, tags } = TagParser.parse(input);

  expect(tags.map(t => t.kind)).toEqual(["file","agent","agent"]);
  expect(tags.map(t => t.value)).toEqual(["notes.md","bob","group"]);
  expect(tags[0].content.startsWith("First para")).toBe(true);
  expect(tags[1].content).toBe("ping you");
  expect(tags[2].content).toBe("back to channel.");
  // clean string preserves everything except the tag tokens
  expect(clean.includes("#file:notes.md")).toBe(false);
  expect(clean.includes("@bob")).toBe(false);
  expect(clean.includes("@group")).toBe(false);
});

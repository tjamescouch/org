import { flattenThink } from "../src/core/utils/think";

test("flattenThink collapses multi-line CoT block (given example)", () => {
  const input = [
    "We","need","to","respond","with","greeting","and","follow","-up",".","Simple","."
  ].join("\n");
  expect(flattenThink(input)).toBe("We need to respond with greeting and follow -up . Simple .");
});

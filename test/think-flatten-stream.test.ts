import { flattenThinkBlockOnce } from "../src/core/utils/stdout-think-flatten";

test("flattens multi-line CoT prelude without assistant anchor", () => {
  const sample =
`**** alice @ 3:01:00 AM:
We
need
to
respond
with
greeting
and
follow
-up
.
Simple
.
Hello! How are you doing today?`;

  const [rewritten, changed] = flattenThinkBlockOnce(sample);
  expect(changed).toBe(true);
  expect(rewritten).toContain("**** alice @ 3:01:00 AM:");
  expect(rewritten).toMatch(/We need to respond with greeting and follow -up \. Simple \.\nHello! How are you doing today\?/);
});

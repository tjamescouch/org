import { flattenThinkBlockOnce } from "../src/core/utils/stdout-think-flatten";

test("streaming CoT flattener collapses multi-line prelude", () => {
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
assistant:Hello! How are you doing today?`;

  const [rewritten, changed] = flattenThinkBlockOnce(sample);
  expect(changed).toBe(true);
  expect(rewritten).toContain("**** alice @ 3:01:00 AM:");
  expect(rewritten).toContain("We need to respond with greeting and follow -up . Simple .\nassistant:Hello! How are you doing today?");
});

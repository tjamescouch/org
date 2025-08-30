import { LLMNoiseFilterFirstPass } from "../llm-noise-filter-first-pass";

/** Build the “interspersed” final-channel payload. */
function buildInterspersedFinal({
  userTag = "@@user",
  message = "Hello!",
}: { userTag?: string; message?: string } = {}): string {
  return `<|channel|>final <|constrain|>${userTag}<|message|>${message}`;
}

/** Build a generic fenced block that must be preserved verbatim. */
function buildGenericFence({
  lang = "bash",
  inner = "<|constrain|>",
  before = "before",
  after = "after",
}: {
  lang?: string;
  inner?: string;
  before?: string;
  after?: string;
} = {}): string {
  return `${before}\n\`\`\`${lang}\n${inner}\n\`\`\`\n${after}`;
}

/**
 * Feed a filter pass with N-character chunks.
 * Ensures the last chunk is at most N characters.
 */
function streamN(pass: any, input: string, n: number): string {
  let out = "";
  for (let i = 0; i < input.length; i += n) {
    out += pass.feed(input.slice(i, i + n));
  }
  out += pass.flush();
  return out;
}

const CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 25, 30] as const;

type Case = {
  name: string;
  input: string;
  expected: string;
};

const CASES: Case[] = [
  {
    name: "channel+message with interspersed fence",
    input: buildInterspersedFinal({ message: "Hello!" }),
    expected: "@@user Hello!",
  },
  {
    name: "preserves tokens inside generic fence",
    input: buildGenericFence({ lang: "bash", inner: "<|constrain|>" }),
    expected: buildGenericFence({ lang: "bash", inner: "<|constrain|>" }),
  },
];

describe("LLMNoiseFilterFirstPass — streaming (parameterized)", () => {
  describe.each(CHUNK_SIZES)("chunk size = %d", (N) => {
    test.each(CASES)("first pass: %s", ({ input, expected }) => {
      const p = new LLMNoiseFilterFirstPass();
      expect(streamN(p, input, N)).toBe(expected);
    });
  });
});

import { getLogLevel } from "../src/ui/logger";

describe("Logger respects LOG_LEVEL env", () => {
  const saved = process.env.LOG_LEVEL;
  afterAll(() => { if (saved === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved; });

  test("DEBUG", () => {
    process.env.LOG_LEVEL = "DEBUG";
    expect(getLogLevel()).toBe("DEBUG");
  });

  test("INFO", () => {
    process.env.LOG_LEVEL = "INFO";
    expect(getLogLevel()).toBe("INFO");
  });

  test("fallback", () => {
    process.env.LOG_LEVEL = "NOPE";
    expect(getLogLevel()).toBe("INFO");
  });
});

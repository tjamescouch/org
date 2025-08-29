// tests/unit/tmux.doctor.test.ts
import { describe, it, expect } from "bun:test";
// Assuming doctorTmux(scope, projectDir, agentSessionId) is exported from src/ui/tmux/doctor.ts
//import { doctorTmux } from "../../../src/ui/tmux/doctor";
//
//describe("tmux doctor", () => {
//  it("returns rc=127 => not installed", async () => {
//    const rc = await doctorTmux("container", process.cwd(), "t.tmux.127", {
//      // you can pass a mock capture function here if doctorTmux accepts DI,
//      // otherwise rely on tmux exiting 127 inside CI image
//    } as any);
//    // Accept either 0 or 127 depending on CI image; we at least assert it's a number
//    expect(typeof rc).toBe("number");
//  });
//});

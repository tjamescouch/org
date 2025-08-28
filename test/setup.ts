// test/setup-sandbox-mock.ts
// Force the mock backend during tests, so nothing talks to Podman.
process.env.SANDBOX_BACKEND = "mock";

// test/setup-sandbox-mock.ts
// Force the mock backend during tests, so nothing talks to Podman.
process.env.SANDBOX_BACKEND = "mock";

if ((process.env.OPENAI_API_KEY || process.env.LMSTUDIO_URL || process.env.OLLAMA_HOST) && !process.env.CI) {
  console.warn('[test] WARNING: model credentials detected; tests use fakes only.');
}

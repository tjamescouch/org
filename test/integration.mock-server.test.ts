import { chatOnce } from '../src/transport/chat';
import * as http from 'http';

/**
 * Integration test that starts a temporary mock server to simulate a chat
 * provider.  The mock server serves the expected endpoints for the
 * preflight checks (`/api/version` and `/api/tags`) as well as the
 * chat completions endpoint (`/v1/chat/completions`).  Each chat
 * completion response is returned after a random short delay to
 * simulate network jitter.  The test verifies that chatOnce() is
 * resilient to variable response times and returns the mocked
 * assistant content.
 */
async function run(): Promise<void> {
  // Pick a free port between 5000 and 9000.
  const port = 5000 + Math.floor(Math.random() * 4000);

  // HTTP server that responds to version, tags, and chat completions.
  const server = http.createServer((req, res) => {
    // Preflight: version endpoint
    if (req.method === 'GET' && req.url === '/api/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: 'mock' }));
      return;
    }
    // Preflight: tags endpoint
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
      return;
    }
    // Chat completions endpoint
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      // Consume the request body but ignore its contents
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        // Respond after a random delay between 50 and 200 ms
        const delay = 50 + Math.floor(Math.random() * 150);
        setTimeout(() => {
          const response = {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Mock reply from server',
                },
              },
            ],
          };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(response));
        }, delay);
      });
      return;
    }
    // Default: 404
    res.statusCode = 404;
    res.end('Not Found');
  });

  await new Promise<void>(resolve => server.listen(port, resolve));

  try {
    const messages = [
      { role: 'user', content: 'Hello' } as any,
    ];
    // Use chatOnce() with the mock baseUrl and model.  Base URL must be
    // without trailing slash; chatOnce() will append /v1/chat/completions.
    const result = await chatOnce('integration-test', messages, {
      baseUrl: `http://localhost:${port}`,
      model: 'mock',
      // Use a short timeout for the chat call to avoid hanging tests
      num_ctx: 1024,
    } as any);
    if (!result || result.content !== 'Mock reply from server') {
      throw new Error(`unexpected chatOnce result: ${JSON.stringify(result)}`);
    }
  } finally {
    // Ensure the server is closed regardless of test outcome
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
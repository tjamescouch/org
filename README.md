Here’s a clean, up-to-date README.md you can drop in for org.

⸻

org

A command-line tool for orchestrating a group of LLMs with tool-calling, safe execution inside a VM, and a simple “candidate vs current” workflow driven by Git.

Highlights
	•	Chat Completions + Tools: Uses Ollama’s /v1/chat/completions with streaming and OpenAI-style tools.
	•	Shell & Python tools:
	•	sh — run POSIX commands inside the VM (Bun spawn).
	•	python_run — execute Python snippets with a timeout (Bun spawn).
	•	AgentModel: Can switch chat modes via tool (chat_mode → group / direct:<model> / file:<path>), and call sh.
	•	PythonModel: Uses tool calls to run Python, consumes tool output internally, responds with summarized results.
	•	Robust tool parsing: runWithTools executes declared and embedded tool calls in the same turn (errant tool JSON is extracted/cleaned).
	•	Streaming: chatOnce(stream:true) accumulates SSE deltas to bypass Ollama’s 5-minute non-streaming timeout; supports delta printing.
	•	Concurrency control: ChannelLock (tiny FIFO lock) to serialize critical sections.
	•	Safe runtime: Runs in a VM with host-only access to Ollama; optional egress blocking with ufw.
	•	Candidate testing: Run current and candidate generations concurrently (ports 7001/7002) and promote via Git merge; rollback via git revert.

⸻

Architecture (files)

/org
├─ main.ts                 # boots the chat room / registers models
├─ chat.ts                 # chatOnce(streaming), runWithTools (tools + embedded), types
├─ agent-model.ts          # AgentModel: sh, chat_mode, audience routing
├─ python-model.ts         # PythonModel: python_run tool (Bun-native)
├─ model.ts                # base Model interface + RoomMessage, broadcast/sendTo hooks
├─ simple-context-model.ts # minimal context-preserving model (baseline)
├─ extract-tool-calls.ts   # robust extractor for embedded "tool_calls":[...]
├─ channel-lock.ts         # ChannelLock (dependency-free)
├─ ops/                    # run/promotion helpers (inside VM)
│  ├─ run.sh               # start on a port in tmux
│  ├─ stop.sh              # stop tmux session
│  ├─ start-current.sh     # checkout main, run on :7001
│  ├─ start-candidate.sh   # branch cand/<ts>, run on :7002
│  ├─ fitness.sh           # health/fitness gate for candidate
│  ├─ promote.sh           # merge --no-ff cand → main, tag, restart current
│  └─ rollback.sh          # git revert last promote-merge, restart current
└─ README.md


⸻

Requirements
	•	VM guest: Debian 12 (ARM64) or similar, Bun v1.2+, python3, tmux, git, curl.
	•	Host: Ollama ≥ 0.11 listening on host-only IP.

export OLLAMA_HOST="http://192.168.56.1:11434"
ollama serve


	•	VM → Host-only networking working (e.g., VM IP 192.168.56.101, host 192.168.56.1).

⸻

Configure

Environment (in VM):

export OLLAMA_BASE="http://192.168.56.1:11434"
export OLLAMA_MODEL="gpt-oss:120b"   # or a smaller model while iterating

Bun types (if using Node types anywhere):

bun add -d bun-types @types/node


⸻

Install & Run (developer)

bun install
bun run main.ts

From another shell, test the HTTP/chat entrypoint (if you expose one) or directly run your room driver.

⸻

How tool calling works
	•	chatOnce posts to /v1/chat/completions with stream:true.
	•	We stitch deltas (delta.content, delta.tool_calls) until [DONE].
	•	runWithTools loop:
	1.	Ask model → get assistant text + tool_calls (if any).
	2.	Also parse embedded tool_calls JSON inside the assistant text (extractToolCallsFromText).
	3.	Push the assistant turn (cleaned content; unified tool_calls).
	4.	Execute all tool calls sequentially; append their tool messages.
	5.	Repeat until no tools requested; caller handles the final assistant message(s).

This ensures tags and tool calls in the same turn are honored.

⸻

Models

AgentModel
	•	Tools:
	•	sh(cmd, timeout_s) — executes shell via Bun.spawn("sh", ["-c", cmd]).
	•	chat_mode(mode) — switch audience:
	•	group (broadcast),
	•	direct:<modelId> (one recipient),
	•	file:<path> (append output to file).
	•	Never dumps raw tool output unless explicitly asked.

PythonModel
	•	Tool:
	•	python_run(code, timeout_s) — runs python3 -S main.py with timeout; returns stdout/stderr to the model only; user sees summarized answer.

⸻

Concurrency

ChannelLock provides a simple async lock:

const release = await lock.waitForLock(10_000);
try {
  // critical section
} finally {
  release();
}

Use it around shared resources (files, single-turn tools that must not interleave).

⸻

Streaming deltas to console

// Bun
if (delta.content) Bun.stdout.write(delta.content);

// Node
// if (delta.content) process.stdout.write(delta.content);


⸻

Candidate vs Current (inside VM)

Run both generations side-by-side and promote with Git merges; rollback via reverts.

Start current (main) on :7001:

./ops/start-current.sh

Start candidate on :7002 (creates cand/<timestamp>):

./ops/start-candidate.sh
# edit… commit often:
git add -A && git commit -m "improve tool merge in runWithTools"
./ops/stop.sh agent-candidate && ./ops/start-candidate.sh "$(git branch --show-current)"

Fitness gate:

./ops/fitness.sh 7002

Promote (merge –no-ff to main, tag, restart current):

./ops/promote.sh

Rollback (revert the last promote merge, restart current):

./ops/rollback.sh

This keeps a full history (no destructive resets).

⸻

Security (VM)
	•	Host-only network; no bridged adapter.
	•	Bind Ollama to host-only IP (192.168.56.1).
	•	Optionally block VM egress with ufw:

sudo ufw --force reset
sudo ufw default deny outgoing
sudo ufw allow out to 192.168.56.1 port 11434 proto tcp
sudo ufw enable



⸻

Troubleshooting
	•	Timeouts: always use stream:true and disable Bun’s fetch timeout (timeout:false).
	•	No tool calls: check finish_reason (tool_calls vs stop), and verify embedded extraction.
	•	Interleaving: wrap multi-step critical ops in ChannelLock.

⸻

License

MIT.

# cchat – Architecture Document  

*Prepared by **Carrol** (Architect). This document describes the internal design of the `cchat` CLI chat and file‑transfer application. It follows Alice’s product specification and guides Bob’s implementation.*  

---  

## 1. Overview  
`cchat` consists of three logical components:  

| Component | Responsibility |
|-----------|----------------|
| **Common library** (`cchat::proto`, `cchat::util`) | Message framing, serialization, checksum utilities, logging helpers – shared by server and client. |
| **Server** (`cchat::server`) | Listens for TCP connections, maintains a registry of active clients, broadcasts chat messages, routes file‑transfer streams, handles graceful shutdown. |
| **Client** (`cchat::client`) | Connects to a server, provides interactive CLI (or scripted mode) for chat and file transfer, reports status to the user. |

All components are written in standard C++17 and depend only on Boost.Asio (network I/O), OpenSSL’s SHA‑256 implementation (for integrity checks), and the C++ Standard Library.

---  

## 2. Design Goals & Constraints  
- **Portability** – Must compile on Linux, macOS, Windows (MinGW/MSVC). No OS‑specific APIs beyond Boost.Asio.  
- **Performance** – ≤ 50 ms chat latency on LAN; file throughput ≥ 80 % of raw TCP bandwidth.  
- **Reliability** – Automatic retransmission for transient errors; SHA‑256 verification after each transfer.  
- **Extensibility** – Hook points for future TLS (OpenSSL) without breaking the existing protocol.  

---  

## 3. High‑Level Architecture  

+----------------------+          +----------------------+
|      Client A        |          |      Server          |
|  (CLI + async I/O)   |<-------->|  (io_context pool)   |
+----------+-----------+          +----------+-----------+
           ^                                 ^
           | TCP (Boost.Asio)                |
           v                                 v
+----------------------+          +----------------------+
|      Client B        |          |      Client C ...    |
+----------------------+          +----------------------+

- **Server** runs a single `boost::asio::io_context` with a configurable thread pool (default = number of CPU cores). Each accepted socket is wrapped in a `Session` object that owns its own strand to serialize per‑client operations.  
- **Client** uses one `io_context`. The interactive CLI runs on the main thread, while all network I/O is posted to the `io_context`. File transfers are performed by a dedicated background worker thread (or via asynchronous reads/writes) so that chat input remains responsive.  

---  

## 4. Protocol Specification  

All traffic is **UTF‑8** encoded text unless otherwise noted. Each logical message is prefixed with a **4‑byte big‑endian length field**, followed by the payload bytes. This framing avoids ambiguity when binary file data is transmitted.

### 4.1 Message Types  

| Type | Identifier (ASCII) | Payload (JSON) |
|------|---------------------|----------------|
| `HELLO`   | `"HEL"` | `{ "username": "<string>" }` – client → server on connect. |
| `WELCOME` | `"WEL"` | `{ "client_id": <uint64>, "message": "Welcome" }` – server → client after successful registration. |
| `CHAT`    | `"MSG"` | `{ "from": "<username>", "text": "<string>" }` – broadcast chat line. |
| `SEND_REQ`| `"SND"` | `{ "filename": "<string>", "size": <uint64>, "dest": ["<user1>", ...] }` – client → server to start a file transfer. |
| `SEND_ACK`| `"ACK"` | `{ "transfer_id": <uint64> }` – server → sender confirming acceptance. |
| `DATA`    | `"DAT"` | binary chunk (no JSON). Length field indicates size of the chunk (max 65536 bytes). |
| `FINISH`  | `"END"` | `{ "transfer_id": <uint64>, "sha256": "<hex>" }` – sender → server after last data chunk. |
| `COMPLETE`| `"CMP"` | `{ "transfer_id": <uint64>, "status":"OK"|"ERROR", "reason"?:"<string>" }` – server → receiver(s) indicating transfer result. |
| `ERROR`   | `"ERR"` | `{ "code": <int>, "msg":"<string>" }` – any side can report protocol errors. |
| `GOODBYE` | `"GBY"` | `{ "reason":"<string>" }` – graceful disconnect (client or server). |

*All JSON payloads are serialized without whitespace to keep the wire format compact.*

### 4.2 Handshake  

1. **TCP connection** established.  
2. Client sends `HELLO`.  
3. Server validates username uniqueness:  
   - If unique → `WELCOME` + registers client.  
   - If duplicate → `ERROR` (code = 1001) and closes the socket.  

### 4.3 Chat Flow  

- Client reads a line from stdin, builds a `CHAT` message with its own username, sends to server.  
- Server forwards the same `CHAT` payload to **all** connected clients (including the sender for echo consistency).  

### 4.4 File Transfer Flow  

1. **Initiation** – Sender issues `SEND_REQ`. `dest` may be empty (`[]`) meaning broadcast; otherwise a list of target usernames.  
2. Server checks that all destinations exist and are not busy with another incoming transfer (optional per‑client limit). If OK → `SEND_ACK` containing a globally unique `transfer_id`.  
3. Sender streams one or more `DATA` messages, each ≤ 64 KB. The server forwards each chunk **unchanged** to every destination client that accepted the request.  
4. After the final data chunk, sender sends `FINISH` with SHA‑256 of the original file.  
5. Each receiver computes its own SHA‑256 while writing to a temporary file. Upon receipt of the last chunk, it compares hashes:  
   - If match → writes the temp file to the target location and replies `COMPLETE` (status = OK) to server.  
   - If mismatch → `COMPLETE` with status = ERROR and reason “checksum”.  
6. Server forwards the final `COMPLETE` status to the original sender, which reports success/failure to its CLI.  

### 4.5 Graceful Shutdown  

- **Client** sends `GOODBYE`. Server acknowledges by broadcasting a `CHAT` message `"User <name> left"` and removes the session.  
- **Server** on SIGINT: broadcasts a special `CHAT` (or dedicated `SHUTDOWN`) informing all clients, then closes each socket after sending `GOODBYE`. Clients receiving this notification exit automatically.  

---  

## 5. Threading & Concurrency Model  

| Component | Concurrency Strategy |
|-----------|----------------------|
| **Server** | - One `io_context` with N worker threads (configurable). <br> - Each `Session` owns a strand (`boost::asio::strand`) to serialize reads/writes per client, preventing data races. <br> - Shared structures (client registry, transfer map) protected by `std::mutex`. |
| **Client** | - Single `io_context` on the main thread for UI interaction. <br> - Network operations posted to the same context; a separate background thread handles file I/O during transfers (reading source file or writing destination). <br> - Communication between UI and worker via thread‑safe queues (`std::queue` + mutex/condition_variable) or Boost.Asio’s `post`. |
| **File Transfer** | - Chunked reads/writes are asynchronous; the sender may pipeline up to 4 chunks without waiting for ACKs (flow control handled by TCP). <br> - Receiver writes each chunk directly to a pre‑allocated temporary file descriptor. |

### 5.1 Error Recovery  

- **Transient network errors** (e.g., `ECONNRESET`) cause the affected session to be closed; server notifies remaining clients via a `CHAT` message.  
- **Partial file transfer**: If any receiver reports checksum failure, the sender receives a `COMPLETE` with status = ERROR and may retry. Temporary files are deleted automatically on error.  

---  

## 6. Logging & Diagnostics  

- A lightweight logger (`cchat::log`) writes timestamped entries to stdout or an optional file (set via CLI `--log`).  
- Verbose mode (`-v`) logs: connection events, message IDs, transfer start/end, checksum values, and any protocol errors.  
- Log format is plain text for easy grep; future integration with syslog or JSON logging can be added without code changes.  

---  

## 7. Extensibility – TLS Hook  

The current TCP socket (`boost::asio::ip::tcp::socket`) will be abstracted behind an interface `cchat::net::Stream`. For the MVP it is a thin wrapper around the raw socket. To enable TLS later:

1. Implement `TlsStream` using `boost::asio::ssl::stream<tcp::socket>`.  
2. Provide factory functions that select either `PlainStream` or `TlsStream` based on compile‑time flags (`ENABLE_TLS`).  
3. Protocol framing (length prefix) remains unchanged; encryption is applied at the transport layer, transparent to higher layers.  

---  

## 8. Configuration Parameters  

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--port` / `-p` | `12345` | TCP listening/connection port. |
| `--host` / `-h` | *required* (client) | Server address. |
| `--user` / `-u` | Prompted interactively | Username; must be unique per session. |
| `--log` | stdout | Log destination file path. |
| `--verbose` / `-v` | off | Enable verbose logging. |
| `--threads` | CPU cores | Server thread‑pool size (optional). |
| `--chunk-size` | `65536` bytes | Max data chunk for file transfer. |

---  

## 9. Open Questions & Suggested Decisions  

1. **File Transfer Destination** – *Suggested*: support both broadcast (`dest=[]`) and targeted list of usernames. This adds little protocol complexity and satisfies future use‑cases.  
2. **Maximum File Size** – *Suggested*: No hard limit; rely on 64 KB chunking and `uint64` size field (supports up to 16 EB). For the MVP we can enforce a sanity check (e.g., reject > 1 GiB) to avoid accidental misuse.  
3. **Authentication** – *Suggested*: Keep the MVP open (LAN only). Add an optional “shared secret” token (`--auth <token>`) that, if supplied, is included in the `HELLO` payload and verified by the server. This provides a simple barrier without full user management.  

*Alice’s final decisions on these points will be reflected in subsequent revisions.*  

---  

## 10. Deliverables for Bob  

- Implement **Common library** (`proto.hpp/cpp`, `log.hpp`).  
- Build **Server** with async accept loop, session handling, and transfer manager.  
- Build **Client** with interactive CLI, async I/O, and file‑transfer worker.  
- Provide **unit tests** for protocol framing and checksum utilities.  
- Supply **E2E test scripts** (Bash + `expect` or Python) that exercise the flow described in Alice’s spec.  

---  

*End of Architecture Document.*

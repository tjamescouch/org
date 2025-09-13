#!/usr/bin/env python3
import argparse, asyncio, sys

async def _pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def _handle_client(cli_r, cli_w, uds_path):
    # Retry connect to UDS briefly (startup races)
    for _ in range(40):
        try:
            svr_r, svr_w = await asyncio.open_unix_connection(uds_path)
            break
        except Exception:
            await asyncio.sleep(0.1)
    else:
        try: cli_w.close()
        except Exception: pass
        return
    await asyncio.gather(_pipe(cli_r, svr_w), _pipe(svr_r, cli_w))

async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--tcp", default="127.0.0.1:11434")
    p.add_argument("--unix", default="/run/llm.sock")
    a = p.parse_args()
    host, port = a.tcp.rsplit(":", 1)
    port = int(port)
    server = await asyncio.start_server(lambda r,w: _handle_client(r,w,a.unix), host, port, reuse_port=False)
    print(f"[uds-bridge] {host}:{port} -> {a.unix}", file=sys.stderr, flush=True)
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

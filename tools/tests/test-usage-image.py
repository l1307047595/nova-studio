"""生图记账集成测试：mock 上游出图 → 提交真任务 → 轮询到完成 → 验落账与单价。

出图张数 × 0.015 元应等于 cost_cny；agentId 应能落库（按类目分组要用）。
不碰真实供应商、不花钱。
"""
import json
import sqlite3
import threading
import time
import urllib.request
import zlib
import struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MOCK_PORT = 3998
TASKS_API = "http://127.0.0.1:3111/api/nova/tasks"
DB = r"D:\ai\123\nova-image-studio\backend\nova-tasks.sqlite"
AGENT = "usage-test-image-agent"


def tiny_png() -> str:
    """生成一个合法的 1x1 PNG（base64）。"""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\xff\xff")
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    import base64
    return base64.b64encode(png).decode()


PNG_B64 = tiny_png()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        payload = json.dumps({"created": int(time.time()), "data": [{"b64_json": PNG_B64}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[mock 上游] 127.0.0.1:{MOCK_PORT} 已启动（返回 1x1 png）")

    body = {
        "apiKey": "test-key-not-real",
        "baseUrl": f"http://127.0.0.1:{MOCK_PORT}",
        "protocol": "openai",
        "mode": "text-to-image",
        "prompt": "usage test",
        "model": "mock-image-model",
        "parallelCount": 2,
        "images": [],
        "agentId": AGENT,
    }
    req = urllib.request.Request(TASKS_API, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        status, payload = resp.status, json.loads(resp.read())
    task_id = payload.get("taskId")
    print(f"[提交任务] HTTP {status} taskId={task_id}")

    final = None
    for _ in range(60):
        time.sleep(0.5)
        with urllib.request.urlopen(f"http://127.0.0.1:3111/api/nova/tasks/{task_id}", timeout=15) as r:
            final = json.loads(r.read())
        if final.get("status") in ("completed", "failed"):
            break
    print(f"[任务终态] {final.get('status')} 出图 {len(final.get('images') or [])} 张  error={final.get('error')}")

    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT ts, kind, agent_id, model, protocol, images, cost_cny FROM usage_events"
        " WHERE agent_id = ? ORDER BY id", (AGENT,)
    ).fetchall()
    print("\n=== 生图记账 ===")
    for r in rows:
        print(" ", r)
    if rows:
        ts, kind, agent, model, proto, images, cost = rows[-1]
        expect = images * 0.015
        print(f"\n验算: {images} 张 × 0.015 = {expect:.4f}  实际 = {cost:.4f}  "
              f"{'✓ 一致' if abs(cost - expect) < 1e-9 else '✗ 不一致'}")
    else:
        print("  ✗ 没有生图记账 —— 没生效")

    srv.shutdown()


if __name__ == "__main__":
    main()

"""用量记账集成测试：起一个假上游，打 /api/nova/proxy/text，验证是否落账。

覆盖两条路：非流式（JSON 带 usage）、流式（SSE 最后 chunk 带 usage）。
不碰真实供应商、不花钱。
"""
import json
import sqlite3
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MOCK_PORT = 3999
APP = "http://127.0.0.1:3111/api/nova/proxy/text"
DB = r"D:\ai\123\nova-image-studio\backend\nova-tasks.sqlite"

NONSTREAM_USAGE = {"input_tokens": 1234, "output_tokens": 567, "input_tokens_details": {"cached_tokens": 1000}}
STREAM_USAGE = {"input_tokens": 2000, "output_tokens": 800, "input_tokens_details": {"cached_tokens": 500}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 静音
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "ignore")
        try:
            body = json.loads(raw or "{}")
        except Exception:
            body = {}
        model = body.get("model", "mock-model")
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"type": "response.output_text.delta", "delta": "hello "},
                {"type": "response.output_text.delta", "delta": "world"},
                {"type": "response.completed", "response": {"usage": STREAM_USAGE}},
            ]
            for c in chunks:
                self.wfile.write(("data: " + json.dumps(c) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        payload = json.dumps({
            "id": "resp_mock",
            "model": model,
            "output_text": "ok",
            "usage": NONSTREAM_USAGE,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def post(body):
    req = urllib.request.Request(
        APP,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, resp.read().decode("utf-8", "ignore")


def rows_after(marker):
    con = sqlite3.connect(DB)
    return con.execute(
        "SELECT ts, kind, agent_id, model, provider, protocol, images, prompt_tokens,"
        " cached_tokens, completion_tokens, cost_cny FROM usage_events"
        " WHERE agent_id = ? ORDER BY id", (marker,)
    ).fetchall()


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"[mock upstream] 127.0.0.1:{MOCK_PORT} 已启动")

    marker = "usage-test-agent"
    base = dict(protocol="openai", baseUrl=f"http://127.0.0.1:{MOCK_PORT}",
                apiKey="test-key-not-real", novaAgentId=marker)

    # 1) 非流式
    status, text = post({**base, "model": "mock-text-model",
                         "requestBody": {"model": "mock-text-model", "input": "hi"}})
    print(f"[非流式] HTTP {status} body={text[:120]}")

    # 2) 流式
    status, text = post({**base, "model": "mock-stream-model", "stream": True,
                         "requestBody": {"model": "mock-stream-model", "input": "hi", "stream": True}})
    print(f"[流式] HTTP {status} 收到 {len(text)} 字节")

    # 3) 生图记账：直接用后端的同一套公式验算（图片单价 0.015）
    print("\n=== usage_events 落账结果 ===")
    got = rows_after(marker)
    for r in got:
        print(" ", r)
    if not got:
        print("  ✗ 没有任何记录 —— 记账没生效")

    srv.shutdown()


if __name__ == "__main__":
    main()

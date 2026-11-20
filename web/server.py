import base64
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parent
MIMO_URL = "https://api.xiaomimimo.com/v1/chat/completions"
VOICES = {"冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean", "mimo_default"}
DEFAULT_MODEL = "mimo-v2.5-tts"
DESIGN_MODEL = "mimo-v2.5-tts-voicedesign"
CLONE_MODEL = "mimo-v2.5-tts-voiceclone"
MODELS = {DEFAULT_MODEL, DESIGN_MODEL, CLONE_MODEL}
MAX_REFERENCE_BASE64 = 10_000_000
ASSETS = {
    "/": ("index.html", "text/html"),
    "/favicon.png": ("public/favicon.png", "image/png"),
    "/src/main.js": ("src/main.js", "text/javascript"),
    "/src/style.css": ("src/style.css", "text/css"),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


opener = build_opener(NoRedirect)


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, status, message):
        self.respond(status, "application/json; charset=utf-8", json.dumps({"error": message}).encode())

    def do_GET(self):
        asset = ASSETS.get(self.path.partition("?")[0])
        if not asset:
            self.error(404, "页面不存在。")
            return
        name, content_type = asset
        self.respond(200, content_type + "; charset=utf-8", (ROOT / name).read_bytes())

    def read_fields(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_REFERENCE_BASE64 + 8192:
            raise ValueError("请求内容过大或为空。")
        return json.loads(self.rfile.read(length))

    def build_payload(self, fields, test=False, stream=False):
        model = fields.get("model", DEFAULT_MODEL)
        text = "你好，这是一次语音连接测试。" if test else fields["text"].strip()
        style = fields.get("style", "").strip()
        description = fields.get("description", "").strip()
        voice = fields.get("voice", "冰糖")
        reference = fields.get("reference", "")
        if model not in MODELS or not 0 < len(text) <= 100 or len(style) > 200 or len(description) > 300:
            raise ValueError("请检查模型及文本长度。")

        instruction = style
        audio = {"format": "pcm16" if stream else "wav"}
        if model == DESIGN_MODEL:
            if not description and not test:
                raise ValueError("请先填写音色描述。")
            instruction = description or "清晰自然的普通话声音，语速适中。"
            if style:
                instruction += "\n朗读要求：" + style
            audio["optimize_text_preview"] = False
        elif model == CLONE_MODEL:
            media, _, encoded = reference.partition(",")
            if media not in {"data:audio/mpeg;base64", "data:audio/wav;base64"} or not 0 < len(encoded) <= MAX_REFERENCE_BASE64:
                raise ValueError("请上传 MP3 或 WAV 参考音频，文件最大 7.5 MB。")
            try:
                base64.b64decode(encoded, validate=True)
            except ValueError:
                raise ValueError("参考音频编码无效，请重新上传。") from None
            audio["voice"] = reference
        else:
            if voice not in VOICES:
                raise ValueError("请选择小米预置音色。")
            audio["voice"] = voice

        messages = [{"role": "assistant", "content": text}]
        if instruction:
            messages.insert(0, {"role": "user", "content": instruction})
        return {"model": model, "messages": messages, "audio": audio, "stream": stream}

    def call_mimo(self, key, payload):
        request = Request(
            MIMO_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "api-key": key},
            method="POST",
        )
        with opener.open(request, timeout=60) as response:
            result = json.load(response)
        audio = base64.b64decode(result["choices"][0]["message"]["audio"]["data"], validate=True)
        if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise ValueError
        return audio

    def stream_mimo(self, key, payload):
        request = Request(
            MIMO_URL,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "api-key": key, "Accept": "text/event-stream"},
            method="POST",
        )
        with opener.open(request, timeout=60) as response:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    line = response.readline()
                    if not line:
                        break
                    if not line.startswith(b"data:"):
                        continue
                    value = line[5:].strip()
                    if value == b"[DONE]":
                        self.wfile.write(b'{"done":true}\n')
                        self.wfile.flush()
                        break
                    try:
                        chunk = json.loads(value)
                        audio = chunk.get("choices", [{}])[0].get("delta", {}).get("audio")
                        encoded = audio.get("data") if audio else None
                        if encoded:
                            message = json.dumps({"data": encoded, "done": False}, ensure_ascii=False).encode()
                            self.wfile.write(message + b"\n")
                            self.wfile.flush()
                    except (json.JSONDecodeError, AttributeError, IndexError, TypeError):
                        continue
            except (BrokenPipeError, ConnectionResetError):
                return

    def do_POST(self):
        if self.path not in {"/api/tts", "/api/tts/stream", "/api/test"}:
            self.error(404, "接口不存在。")
            return

        port = self.server.server_port
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in allowed_hosts or (origin and origin != f"http://{host}"):
            self.error(403, "请从本地页面调用此接口。")
            return

        key = self.headers.get("api-key", "").strip()
        if not key:
            self.error(401, "请先填写 MIMO_API_KEY。")
            return
        try:
            fields = self.read_fields()
            payload = self.build_payload(
                fields,
                test=self.path == "/api/test",
                stream=self.path == "/api/tts/stream",
            )
        except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
            self.error(400, "请检查文本、模型、朗读风格、音色或参考音频。")
            return
        except ValueError as error:
            self.error(400, str(error))
            return
        if self.path == "/api/tts/stream":
            try:
                self.stream_mimo(key, payload)
            except HTTPError as error:
                messages = {
                    401: "小米 MiMo 拒绝了 API Key，请检查模型配置。",
                    403: "当前 API Key 无权调用小米 MiMo TTS。",
                    429: "小米 MiMo 请求过于频繁，请稍后再试。",
                }
                self.error(error.code if 400 <= error.code <= 599 else 502,
                           messages.get(error.code, f"小米 MiMo 返回 HTTP {error.code}。"))
            except (TimeoutError, socket.timeout):
                self.error(504, "小米 MiMo 请求超时，请重试。")
            except (URLError, OSError):
                self.error(502, "无法连接小米 MiMo，请检查网络或代理。")
            return

        try:
            audio = self.call_mimo(key, payload)
        except HTTPError as error:
            messages = {
                401: "小米 MiMo 拒绝了 API Key，请检查模型配置。",
                403: "当前 API Key 无权调用小米 MiMo TTS。",
                429: "小米 MiMo 请求过于频繁，请稍后再试。",
            }
            self.error(error.code if 400 <= error.code <= 599 else 502,
                       messages.get(error.code, f"小米 MiMo 返回 HTTP {error.code}。"))
            return
        except (TimeoutError, socket.timeout):
            self.error(504, "小米 MiMo 请求超时，请重试。")
            return
        except (URLError, OSError):
            self.error(502, "无法连接小米 MiMo，请检查网络或代理。")
            return
        except (ValueError, KeyError, IndexError, TypeError):
            self.error(502, "小米 MiMo 没有返回有效的 WAV 音频。")
            return

        if self.path == "/api/test":
            self.respond(200, "application/json; charset=utf-8", b'{"ok":true}')
        else:
            self.respond(200, "audio/wav", audio)


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "8765"))
    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        print(f"MIMO-TTS 已启动：http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()

"""Optional loopback ASR for AgentLink's bounded 16-kHz PCM video excerpts.

Requires faster-whisper and a complete local CTranslate2 model directory.
Does not download models or accept arbitrary model/file paths over HTTP.
"""
import argparse
import io
import json
import os
import re
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_FILE_BYTES = 2_000_000
MAX_REQUEST_BYTES = 2_100_000


def pcm_samples(data):
    if not 44 <= len(data) <= MAX_FILE_BYTES:
        raise ValueError("invalid audio size")
    try:
        with wave.open(io.BytesIO(data)) as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
                raise ValueError("expected mono 16-kHz PCM16 WAV")
            count = audio.getnframes()
            if not 0 < count <= 60 * 16000:
                raise ValueError("audio exceeds the 60-second bound")
            pcm = audio.readframes(count)
            if len(pcm) != count * 2:
                raise ValueError("incomplete PCM data")
            return pcm
    except (wave.Error, EOFError) as error:
        raise ValueError("invalid WAV") from error


def parse_upload(content_type, body, model_id):
    if len(body) > MAX_REQUEST_BYTES or len(content_type) > 1024 or "\r" in content_type or "\n" in content_type:
        raise ValueError("invalid multipart request")
    envelope = ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + body
    message = BytesParser(policy=default).parsebytes(envelope)
    if message.get_content_type() != "multipart/form-data" or not message.is_multipart():
        raise ValueError("expected multipart form")
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_content_disposition() != "form-data" or name not in {"model", "response_format", "file"} or name in fields:
            raise ValueError("unsupported or duplicate field")
        fields[name] = part.get_payload(decode=True)
    if fields.get("model") != model_id.encode() or fields.get("response_format") != b"json" or not isinstance(fields.get("file"), bytes):
        raise ValueError("invalid transcription parameters")
    return pcm_samples(fields["file"])


def create_server(transcribe, model_id="whisper-local", port=8000):
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,80}", model_id) or not 0 <= port <= 65535:
        raise ValueError("invalid server settings")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Do not log uploaded audio, text, headers or credentials.

        def reply(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            if self.path != "/v1/audio/transcriptions":
                self.reply(404, {"error": "unknown endpoint"})
                return
            if self.headers.get("Origin") or self.headers.get("Transfer-Encoding"):
                self.reply(403, {"error": "unsupported request source or encoding"})
                return
            try:
                self.connection.settimeout(10)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST_BYTES:
                    self.reply(413, {"error": "request size exceeds bound"})
                    return
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("incomplete request")
                pcm = parse_upload(self.headers.get("Content-Type", ""), body, model_id)
            except (ValueError, OSError, UnicodeError, RecursionError):
                self.reply(400, {"error": "expected a bounded mono 16-kHz PCM16 WAV multipart request"})
                return
            try:
                text = transcribe(pcm) if any(pcm) else ""
                if not isinstance(text, str) or len(text) > 12000:
                    raise ValueError("invalid ASR output")
            except Exception:
                self.reply(502, {"error": "local transcription failed"})
                return
            self.reply(200, {"text": text.strip()})

    # Single active request; no background inference queue or externally bound port.
    return HTTPServer(("127.0.0.1", port), Handler)


def load_transcriber(model_path, cpu_threads):
    folder = Path(model_path).expanduser().resolve()
    if not all((folder / name).is_file() for name in ["model.bin", "config.json", "tokenizer.json"]):
        raise ValueError("a complete local CTranslate2 model directory is required")
    if not 1 <= cpu_threads <= 8:
        raise ValueError("cpu threads must be between 1 and 8")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import numpy as np
    from faster_whisper import WhisperModel

    model = WhisperModel(str(folder), device="cpu", compute_type="int8", cpu_threads=cpu_threads, num_workers=1, local_files_only=True)

    def transcribe(pcm):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        segments, _info = model.transcribe(samples, beam_size=5, temperature=0.0, condition_on_previous_text=False, vad_filter=False)
        return "".join(segment.text for segment in segments).strip()

    return transcribe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True, help="complete local CTranslate2 model directory; never auto-downloaded")
    parser.add_argument("--model-id", default="whisper-local")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cpu-threads", type=int, default=2)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,80}", args.model_id) or not 0 <= args.port <= 65535:
        parser.error("invalid model identifier or port")
    try:
        transcribe = load_transcriber(args.model_path, args.cpu_threads)
    except (ValueError, ImportError) as error:
        parser.error("local model or optional faster-whisper dependencies are unavailable: " + type(error).__name__)
    with create_server(transcribe, args.model_id, args.port) as server:
        print(json.dumps({"ready": True, "host": "127.0.0.1", "port": server.server_port, "model": args.model_id}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

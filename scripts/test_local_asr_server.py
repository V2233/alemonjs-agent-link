import io
import json
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from scripts.local_asr_server import MAX_REQUEST_BYTES, create_server, load_transcriber, parse_upload, pcm_samples


def wav(seconds=0.01, channels=1, rate=16000, silent=False):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(struct.pack("<h", 0 if silent else 500) * int(seconds * rate) * channels)
    return output.getvalue()


def multipart(audio, model=b"whisper-local", extra=None):
    fields = [("model", model), ("response_format", b"json"), ("file", audio)] + (extra or [])
    body = b""
    for name, value in fields:
        body += b"--test-boundary\r\nContent-Disposition: form-data; name=\"" + name.encode() + b"\""
        if name == "file":
            body += b"; filename=\"ignored.wav\"\r\nContent-Type: audio/wav"
        body += b"\r\n\r\n" + value + b"\r\n"
    return body + b"--test-boundary--\r\n"


class PCMTests(unittest.TestCase):
    def test_valid_pcm_and_bounded_formats(self):
        self.assertEqual(len(pcm_samples(wav(1))), 32000)
        for data in [b"", wav(0), wav(61), wav(channels=2), wav(rate=48000), wav(1)[:-2], b"x" * 2000001]:
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                pcm_samples(data)

    def test_multipart_strict_fields_and_model_identifier(self):
        mime = "multipart/form-data; boundary=test-boundary"
        self.assertEqual(parse_upload(mime, multipart(wav()), "whisper-local"), pcm_samples(wav()))
        for data in [multipart(wav(), model=b"another-model"), multipart(wav(), extra=[("model", b"whisper-local")]), multipart(wav(), extra=[("path", b"/private/file")]), multipart(b"not-wav")]:
            with self.assertRaises(ValueError):
                parse_upload(mime, data, "whisper-local")
        for mime in ["application/json", "x\r\ny", "x" * 1025]:
            with self.assertRaises(ValueError):
                parse_upload(mime, b"{}", "whisper-local")

    def test_invalid_local_model_fails_without_loading_optional_dependencies(self):
        with tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
            load_transcriber(root, 2)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("local_asr_server.py")), "--help"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn("--model-path", result.stdout)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.inputs = []
        self.output = "本地夹具文字"
        self.error = False

        def transcribe(pcm):
            self.inputs.append(pcm)
            if self.error:
                raise RuntimeError("private-backend-details")
            return self.output

        self.server = create_server(transcribe, port=0)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def request(self, data=None, path="/v1/audio/transcriptions", headers=None):
        request = urllib.request.Request(self.url + path, data=multipart(wav()) if data is None else data, headers={"Content-Type": "multipart/form-data; boundary=test-boundary", **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, json.load(response)

    def test_actual_loopback_http_upload_and_no_store_response(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body, {"text": "本地夹具文字"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.inputs, [pcm_samples(wav())])

    def test_exact_zero_pcm_does_not_invoke_recognition(self):
        status, _, body = self.request(multipart(wav(silent=True)))
        self.assertEqual(status, 200)
        self.assertEqual(body, {"text": ""})
        self.assertEqual(self.inputs, [])

    def test_origin_encoding_size_and_unknown_endpoint_are_rejected_before_recognition(self):
        for params, expected in [({"headers": {"Origin": "https://example.com"}}, 403), ({"headers": {"Transfer-Encoding": "chunked"}}, 403), ({"headers": {"Content-Length": str(MAX_REQUEST_BYTES + 1)}}, 413), ({"path": "/other"}, 404)]:
            with self.subTest(params=params):
                status, _, _ = self.request(**params)
                self.assertEqual(status, expected)
        self.assertEqual(self.inputs, [])

    def test_bad_audio_does_not_reach_model(self):
        status, _, body = self.request(multipart(b"not-a-wav"))
        self.assertEqual(status, 400)
        self.assertEqual(self.inputs, [])
        self.assertNotIn("not-a-wav", json.dumps(body))

    def test_backend_errors_and_oversized_output_do_not_expose_details(self):
        self.error = True
        status, _, body = self.request()
        self.assertEqual(status, 502)
        self.assertNotIn("private", json.dumps(body))
        self.error = False
        self.output = "x" * 12001
        self.assertEqual(self.request()[0], 502)


if __name__ == "__main__":
    unittest.main()

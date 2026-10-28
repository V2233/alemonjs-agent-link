import importlib.util
import json
import os
import platform
import subprocess
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest


def load_bridge():
    root = Path(tempfile.mkdtemp(prefix='agent-link-bridge-test-'))
    module_dir = Path(__file__).parent.parent / 'python'
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))
    os.environ.update({
        'DSH_WORKSPACE_ROOT': str(root / 'workspaces'),
        'DSH_HOME_ROOT': str(root / 'homes'),
        'DSH_BRIDGE_TOKEN': 'test-token'
    })
    spec = importlib.util.spec_from_file_location('dsh_bridge_test', module_dir / 'dsh_bridge.py')
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module, root


class BridgeSafetyTests(unittest.TestCase):
    @unittest.skipUnless(platform.system() == 'Darwin', 'macOS sandbox required')
    def test_attachment_ancestor_open_does_not_allow_sibling_files(self):
        from sandbox_profile import macos_profile
        home = self.root / 'group' / 'home'
        workspace = self.root / 'workspace'
        home.mkdir(parents=True)
        workspace.mkdir()
        outside = self.root / 'outside.txt'
        outside.write_text('private fixture')
        script = Path(__file__).resolve()
        profile = macos_profile(workspace, home, Path(sys.executable), Path(sys.prefix), script, script, 19879)
        code = (
            f'import os\nfd = os.open({str(home.parent.resolve())!r}, os.O_RDONLY)\nos.close(fd)\n'
            f'try: open({str(outside.resolve())!r}).read()\n'
            'except PermissionError: pass\n'
            'else: raise AssertionError("sibling file was readable")\n'
        )
        result = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, sys.executable, '-c', code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def setUp(self):
        self.bridge, self.root = load_bridge()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_model_pool_round_robin_reports_cooldown_and_rewrites_model(self):
        self.bridge.MODEL_POOL = {
            'maxAttempts': 3,
            'retryStatuses': [429],
            'failureThreshold': 2,
            'cooldownSeconds': 30,
            'endpoints': [
                {'id': 'a', 'apiKey': 'sk-a', 'model': 'model-a', 'weight': 1, 'maxConcurrent': 1, 'enabled': True},
                {'id': 'b', 'apiKey': 'sk-b', 'model': 'model-b', 'weight': 1, 'maxConcurrent': 1, 'enabled': True}
            ]
        }
        self.bridge.POOL_ENDPOINTS = self.bridge.MODEL_POOL['endpoints']
        self.bridge.POOL_STATE = {}
        self.bridge.POOL_CURSOR = 0
        first = self.bridge.pool_select()
        second = self.bridge.pool_select()
        self.assertEqual(first['id'], 'a')
        self.assertEqual(second['id'], 'b')
        self.assertIsNone(self.bridge.pool_select(), 'both endpoints are at maxConcurrent')
        body = self.bridge.pool_model_body(b'{"model":"old","messages":[]}', second)
        self.assertEqual(json.loads(body)['model'], 'model-b')
        self.bridge.pool_report(first, 429)
        self.assertGreater(self.bridge.POOL_STATE['a']['cooldownUntil'], 0)
        self.bridge.pool_report(second, 401)
        self.assertTrue(self.bridge.POOL_STATE['b']['disabled'])
        self.assertIsNone(self.bridge.pool_select())

    def test_native_image_input(self):
        parts = [{'type': 'text', 'text': '看看图片'}, {'type': 'image', 'mimeType': 'image/png', 'data': 'aGVsbG8='}]
        self.assertEqual(self.bridge.normalize_chat_input(parts), parts)
        self.assertEqual(self.bridge.chat_input_text(parts), '看看图片')
        for invalid in ([{'type': 'image', 'mimeType': 'text/html', 'data': 'eA=='}], [{'type': 'image', 'mimeType': 'image/png', 'data': '???'}], []):
            with self.assertRaises(ValueError): self.bridge.normalize_chat_input(invalid)

    def test_output_keyword_filter_requires_final_review(self):
        self.bridge.OUTPUT_BLOCKED = set()
        self.assertFalse(self.bridge.output_requires_final_review())
        self.bridge.OUTPUT_BLOCKED = {'secret'}
        self.assertTrue(self.bridge.output_requires_final_review())

    def test_egress_redirects_and_oversized_responses_are_rejected(self):
        self.assertIsNone(self.bridge.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://elsewhere.example'))

        class Response:
            headers = {'Content-Length': '9'}
            def read(self, _size):
                return b'123456789'

        with self.assertRaisesRegex(ValueError, 'too large'):
            self.bridge.read_bounded(Response(), 8)

    def test_tool_policy_enables_only_requested_capabilities(self):
        baseline = {'chat': True, 'web': True, 'files': False, 'terminal': False}
        patch = self.bridge.tool_policy_patch(baseline)

        self.assertIn('- id: tool-web\n  disabled: false', patch)
        self.assertIn('- id: tool-fs\n  disabled: true', patch)
        self.assertIn('- id: tool-bash\n  disabled: true', patch)
        self.assertIn('- id: tool-subagent\n  disabled: true', patch)
        self.assertEqual(self.bridge.valid_capabilities(baseline), baseline)
        self.assertIsNone(self.bridge.valid_capabilities({'web': True}))

    def test_native_files_and_terminal_remain_disabled_even_for_legacy_owner(self):
        caps = {'chat': True, 'web': True, 'files': True, 'terminal': True}
        patch = self.bridge.tool_policy_patch(caps)
        for tool in ('tool-fs', 'tool-fs-search', 'tool-bash', 'tool-pwsh', 'tool-jobs'):
            self.assertIn(f'- id: {tool}\n  disabled: true', patch)
        prompt = self.bridge.trusted_prompt('test', caps)
        self.assertIn('workspace_*', prompt)
        self.assertIn('<agentlink_persona priority="highest">', prompt)
        self.assertIn('不是通用编码代理或助手', prompt)
        self.assertNotIn('可在当前隔离工作区中执行终端命令', prompt)

    def test_chat_only_profile_check_is_cached_until_patch_changes(self):
        calls = 0
        original_run = self.bridge.subprocess.run
        config = '\n'.join(f'- id: {tool}\n  disabled: true' for tool in self.bridge.CHAT_ONLY_TOOL_IDS)

        def fake_run(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            return SimpleNamespace(returncode=0, stdout=config)

        try:
            self.bridge.PROFILE_CHECK = None
            self.bridge.subprocess.run = fake_run
            self.assertIsNone(self.bridge.chat_only_profile_test())
            self.assertIsNone(self.bridge.chat_only_profile_test())
            self.assertEqual(calls, 1)
        finally:
            self.bridge.subprocess.run = original_run

    def test_linux_requires_bubblewrap_and_builds_a_bwrap_launcher(self):
        original_system = self.bridge.platform.system
        original_which = self.bridge.shutil.which
        original_runtime = self.bridge.RUNTIME_PATH
        try:
            self.bridge.platform.system = lambda: 'Linux'
            self.bridge.shutil.which = lambda _name: None
            self.assertIn('bubblewrap', self.bridge.validate_preflight())

            self.bridge.shutil.which = lambda _name: '/usr/bin/bwrap'
            self.bridge.RUNTIME_PATH = Path('/tmp/dsh-runtime')
            command = self.bridge.sandbox_command(self.root / 'workspace', self.root / 'home', 18080, False)
            self.assertEqual(command[0], '/usr/bin/bwrap')
            self.assertIn('--unshare-pid', command)
            self.assertIn('--bind', command)
            self.assertNotIn('/usr/bin/sandbox-exec', command)
        finally:
            self.bridge.platform.system = original_system
            self.bridge.shutil.which = original_which
            self.bridge.RUNTIME_PATH = original_runtime

    def test_linux_namespace_failure_has_actionable_preflight_message(self):
        detail = self.bridge.sandbox_self_test_failure(1, 'bwrap: No permissions to create new namespace', 'Linux')
        self.assertIn('unprivileged user namespaces', detail)
        self.assertNotIn('bwrap:', detail)

    def test_native_windows_has_a_wsl2_remediation_message(self):
        original_system = self.bridge.platform.system
        try:
            self.bridge.platform.system = lambda: 'Windows'
            self.assertIn('WSL2', self.bridge.validate_preflight())
        finally:
            self.bridge.platform.system = original_system

    def test_stale_group_cleanup_only_removes_hashed_expired_directories(self):
        self.bridge.WORKSPACE_ROOT = self.root / 'workspaces'
        self.bridge.HOME_ROOT = self.root / 'homes'
        self.bridge.RUNTIME_ROOT = self.root / 'runtime'
        self.bridge.RETENTION_DAYS = 1
        expired = 'a' * 64
        fresh = 'b' * 64
        preserved = self.bridge.WORKSPACE_ROOT / 'not-a-group'
        for target in (self.bridge.WORKSPACE_ROOT / expired, self.bridge.HOME_ROOT / expired, self.bridge.RUNTIME_ROOT / expired, self.bridge.WORKSPACE_ROOT / fresh, preserved):
            target.mkdir(parents=True, exist_ok=True)
        old = time.time() - 2 * 86400
        for root in (self.bridge.WORKSPACE_ROOT, self.bridge.HOME_ROOT, self.bridge.RUNTIME_ROOT):
            os.utime(root / expired, (old, old))

        self.bridge.cleanup_stale_group_data()

        self.assertFalse((self.bridge.WORKSPACE_ROOT / expired).exists())
        self.assertFalse((self.bridge.HOME_ROOT / expired).exists())
        self.assertFalse((self.bridge.RUNTIME_ROOT / expired).exists())
        self.assertTrue((self.bridge.WORKSPACE_ROOT / fresh).exists())
        self.assertTrue(preserved.exists())

    def test_worker_capacity_evicts_only_idle_worker(self):
        class FakeWorker:
            def __init__(self, key, _port, capabilities):
                self.key = key
                self.capabilities = capabilities
                self.lock = threading.Lock()
                self.last_used = 0
                self.stopped = False

            def stop(self):
                self.stopped = True

        original_worker = self.bridge.Worker
        try:
            self.bridge.Worker = FakeWorker
            self.bridge.MAX_ACTIVE_WORKERS = 1
            capabilities = {'chat': True, 'web': True, 'files': False, 'terminal': False}
            idle = FakeWorker('a' * 64, 1, capabilities)
            self.bridge.WORKERS = {idle.key: idle}

            replacement = self.bridge.get_worker('b' * 64, 1, capabilities)

            self.assertTrue(idle.stopped)
            self.assertEqual(replacement.key, 'b' * 64)
            self.assertEqual(set(self.bridge.WORKERS), {'b' * 64})

            replacement.lock.acquire()
            with self.assertRaises(self.bridge.WorkerCapacityError):
                self.bridge.get_worker('c' * 64, 1, capabilities)
            replacement.lock.release()
        finally:
            self.bridge.Worker = original_worker

    def test_worker_error_detail_is_not_exposed_to_bridge_logs(self):
        original_runtime = self.bridge.RUNTIME_PATH
        self.bridge.RUNTIME_PATH = Path('/tmp/dsh-runtime')
        worker = self.bridge.Worker('a' * 64, 1, {'chat': True, 'web': True, 'files': False, 'terminal': False})

        class Stdin:
            def write(self, _value):
                pass

            def flush(self):
                pass

        try:
            worker.start = lambda: None
            worker.process = type('Process', (), {'stdin': Stdin(), 'stdout': object()})()
            worker.stdout_queue.put(json.dumps({'type': 'error', 'error': 'DSH worker execution failed', 'detail': 'private prompt text'}))

            with self.assertRaisesRegex(self.bridge.WorkerError, 'sandbox worker reported an error') as raised:
                worker.run('private prompt text', 'dsh:qq:group:1', lambda _content: None)

            self.assertNotIn('private prompt text', str(raised.exception))
        finally:
            self.bridge.RUNTIME_PATH = original_runtime

    def test_framework_endpoint_rejects_external_urls_and_bad_tokens(self):
        valid = {'url': 'http://127.0.0.1:12345/mcp', 'token': 'a' * 64}
        self.assertEqual(self.bridge.framework_endpoint(valid), valid)
        for url in ['http://example.com/mcp', 'http://127.0.0.1:12345/other', 'http://127.0.0.1:0/mcp', 'http://127.0.0.1:99999/mcp']:
            with self.assertRaises(ValueError): self.bridge.framework_endpoint({**valid, 'url': url})
        with self.assertRaises(ValueError): self.bridge.framework_endpoint({**valid, 'token': 'bad'})
        self.assertIsNone(self.bridge.framework_endpoint(None))

    def test_framework_binding_is_cleared_on_failure_and_success(self):
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('a' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        endpoint = {'url': 'http://127.0.0.1:12345/mcp', 'token': 'a' * 64}
        def success(*_args):
            worker.dsh_home.mkdir(parents=True, exist_ok=True)
            self.assertEqual(worker.framework, endpoint)
            return {'type': 'result'}
        worker._run = success
        self.assertEqual(worker.run('hello', 'session', lambda _: None, endpoint), {'type': 'result'})
        self.assertIsNone(worker.framework)
        def failure(*_args): raise RuntimeError('fixture')
        worker._run = failure
        with self.assertRaises(RuntimeError): worker.run('hello', 'session', lambda _: None, endpoint)
        self.assertIsNone(worker.framework)
        patch = self.bridge.framework_patch(1234, 'a' * 64)
        self.assertIn('@deepseek-ai/dsh-mcp-client', patch)
        self.assertIn('serverName: framework', patch)


    def test_framework_grants_rotate_and_old_tokens_cannot_reach_later_turns(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import urllib.request
        import urllib.error
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('b' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        self.bridge.WORKERS[worker.key] = worker
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), self.bridge.Handler)
        for server in (upstream, proxy): threading.Thread(target=server.serve_forever, daemon=True).start()
        endpoint = {'url': f'http://127.0.0.1:{upstream.server_port}/mcp', 'token': 'c' * 64}
        tokens, homes = [], []
        def request(token):
            req = urllib.request.Request(f'http://127.0.0.1:{proxy.server_port}/internal/framework/{token}', data=b'{}', headers={'Authorization': f'Bearer {token}'})
            try:
                with urllib.request.urlopen(req, timeout=3) as response: return response.status
            except urllib.error.HTTPError as error:
                code = error.code; error.close(); return code
        def run(*_):
            worker.dsh_home.mkdir(parents=True, exist_ok=True)
            if tokens: self.assertEqual(request(tokens[-1]), 401)
            tokens.append(worker.framework_token); homes.append(worker.dsh_home)
            self.assertEqual(request(tokens[-1]), 200)
            return {'type': 'result'}
        worker._run = run
        try:
            worker.run('one', 'session', lambda _: None, endpoint)
            self.assertEqual(request(tokens[0]), 401)
            worker.run('two', 'session', lambda _: None, endpoint)
            self.assertNotEqual(tokens[0], tokens[1]); self.assertNotEqual(homes[0], homes[1])
            self.assertIsNone(worker.framework_token)
            self.assertFalse(homes[0].exists()); self.assertFalse(homes[1].exists())
        finally:
            for server in (proxy, upstream): server.shutdown(); server.server_close()
            self.bridge.WORKERS.clear()

    def test_personal_key_egress_is_scoped_and_reports_exhaustion(self):
        import http.client
        import io
        from http.server import ThreadingHTTPServer
        from unittest.mock import patch
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('d' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        self.bridge.WORKERS[worker.key] = worker
        worker.personal_api_key = 'sk-fixture-0001'
        self.bridge.MODEL_API_KEY = 'sk-robot-test-12345678'
        self.bridge.MODEL_BASE_URL = 'https://robot.example/v1'
        captured = []
        class Upstream(io.BytesIO):
            status = 402
            headers = {'Content-Type': 'application/json'}
        def open_request(request, **_):
            captured.append((request.full_url, request.get_header('Authorization')))
            return Upstream(b'{}')
        server = ThreadingHTTPServer(('127.0.0.1', 0), self.bridge.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        def send():
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.request('POST', f'/internal/egress/{worker.proxy_token}/chat/completions', body=b'{}', headers={'Authorization': f'Bearer {worker.proxy_token}'})
                response = connection.getresponse(); response.read()
                return response.status
            finally: connection.close()
        try:
            with patch.object(self.bridge.urllib.request, 'build_opener', return_value=SimpleNamespace(open=open_request)):
                self.assertEqual(send(), 402)
                self.assertEqual(captured[-1], ('https://api.deepseek.com/chat/completions', 'Bearer sk-fixture-0001'))
                self.assertTrue(worker.personal_exhausted)
                worker.personal_api_key = None
                self.assertEqual(send(), 402)
                self.assertEqual(captured[-1], ('https://robot.example/v1/chat/completions', 'Bearer sk-robot-test-12345678'))
        finally:
            server.shutdown(); server.server_close(); self.bridge.WORKERS.clear()

    def test_personal_key_is_cleared_after_success_and_failure(self):
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('e' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        old_token = worker.proxy_token
        def run(*_):
            self.assertEqual(worker.personal_api_key, 'sk-fixture-0001')
            raise RuntimeError('fixture')
        worker._run = run
        with self.assertRaises(RuntimeError): worker.run('hello', 'dsh:qq:private:test', lambda _: None, None, 'sk-fixture-0001')
        self.assertIsNone(worker.personal_api_key)
        self.assertNotEqual(worker.proxy_token, old_token)
        def success(*_):
            worker.dsh_home.mkdir(parents=True, exist_ok=True)
            return {'content': 'ok'}
        worker._run = success
        self.assertEqual(worker.run('hello', 'dsh:qq:private:test', lambda _: None, None, 'sk-fixture-0001'), {'content': 'ok'})
        self.assertIsNone(worker.personal_api_key)

    def test_session_snapshot_never_copies_configuration_or_follows_symlinks(self):
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('c' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        worker.turn_id = 'one'
        (worker.dsh_home / 'sessions').mkdir(parents=True)
        (worker.dsh_home / 'sessions' / 'history.jsonl').write_text('fixture history')
        (worker.dsh_home / 'profiles').mkdir()
        (worker.dsh_home / 'profiles' / 'unsafe.yml').write_text('old secret')
        outside = self.root / 'outside.txt'; outside.write_text('must not copy')
        (worker.dsh_home / 'sessions' / 'link').symlink_to(outside)
        worker.save_session_data()
        worker.turn_id = 'two'; worker.restore_session_data()
        self.assertEqual((worker.dsh_home / 'sessions' / 'history.jsonl').read_text(), 'fixture history')
        self.assertFalse((worker.dsh_home / 'profiles').exists())
        self.assertFalse((worker.dsh_home / 'sessions' / 'link').exists())

    def test_messages_proxy_uses_official_deepseek_endpoint_without_changing_compatible_origins(self):
        target = self.bridge.model_egress_target
        self.assertEqual(target('https://api.deepseek.com', 'messages', True), 'https://api.deepseek.com/anthropic/v1/messages')
        self.assertEqual(target('https://api.deepseek.com/v1', 'messages', True), 'https://api.deepseek.com/anthropic/v1/messages')
        self.assertEqual(target('https://api.deepseek.com', 'chat/completions'), 'https://api.deepseek.com/chat/completions')
        self.assertEqual(target('https://gateway.example/v1', 'messages', True), 'https://gateway.example/v1/messages')

    @unittest.skipUnless(platform.system() == 'Darwin', 'macOS sandbox required')
    def test_previous_turn_sandbox_cannot_read_new_turn_credentials(self):
        from sandbox_profile import macos_profile
        old_home = self.root / 'turns' / 'old'
        new_home = self.root / 'turns' / 'new'
        workspace = self.root / 'workspace'
        for directory in (old_home, new_home, workspace): directory.mkdir(parents=True)
        secret = new_home / 'agent-link-tools.patch.yml'
        secret.write_text('new-turn-credential-fixture')
        profile = macos_profile(workspace, old_home, Path(sys.executable), Path(sys.prefix), Path(__file__), Path(__file__), 19879)
        code = f'try: open({str(secret)!r}).read()\nexcept PermissionError: pass\nelse: raise AssertionError("new turn credentials readable")\n'
        result = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, sys.executable, '-c', code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_successful_turn_flushes_native_runtime_before_snapshot(self):
        from unittest.mock import patch
        import io
        self.bridge.RUNTIME_PATH = Path('/tmp/runtime-fixture')
        worker = self.bridge.Worker('e' * 64, 1, {'chat': True, 'web': False, 'files': False, 'terminal': False})
        sequence = []
        class Process:
            pid = 123456
            stdin = io.StringIO()
            def poll(self): return None
            def wait(self, timeout=None): sequence.append('wait'); return 0
        process = Process(); worker.process = process
        with patch.object(self.bridge.os, 'killpg', lambda *_: sequence.append('kill')):
            worker.stop(graceful=True)
        self.assertEqual(json.loads(process.stdin.getvalue())['type'], 'shutdown')
        self.assertEqual(sequence[0], 'wait')

if __name__ == '__main__':
    unittest.main()

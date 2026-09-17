import importlib.util
import json
import os
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
    def setUp(self):
        self.bridge, self.root = load_bridge()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

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


if __name__ == '__main__':
    unittest.main()

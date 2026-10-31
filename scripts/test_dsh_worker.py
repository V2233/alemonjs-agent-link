import importlib.util
import os
import io
import json
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch


with patch.dict(os.environ, {'DSH_WORKSPACE': '/tmp', 'DSH_HOME': '/tmp'}):
    spec = importlib.util.spec_from_file_location('worker_under_test', Path(__file__).parent.parent / 'python/dsh_worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)


class InitializationTests(unittest.TestCase):
    def test_cold_start_recovers_before_ready_and_submits_prompt_once(self):
        events = []
        class Harness:
            starts = 0
            runs = 0

            def start(self):
                self.starts += 1
                if self.starts == 1:
                    raise RuntimeError('cold bootstrap failed')

            def close(self):
                pass

            def start_session(self, _session_id):
                self.assert_ready()
                return self

            def assert_ready(self):
                assert self.starts == 2
                assert any(event.get('type') == 'ready' for event in events)

            def run(self, _message, **_kwargs):
                self.runs += 1
                return SimpleNamespace(final_response='OK', finish_reason='completed', events=[])

        harness = Harness()
        modules = {
            'deepseek_harness': SimpleNamespace(DeepSeekHarness=lambda **_kwargs: harness),
            'deepseek_harness_runtime': SimpleNamespace(bundled_runtime_path=lambda: Path('/tmp/runtime')),
        }
        env = {'DSH_PROXY_TOKEN': 'test', 'DSH_PROXY_BASE_URL': 'http://127.0.0.1:1', 'DSH_CHAT_ONLY_PATCH': '/tmp/patch'}
        command = json.dumps({'type': 'chat', 'sessionId': 'test', 'message': 'hello'}) + '\n'
        with patch.dict('sys.modules', modules), patch.dict(os.environ, env), patch('sys.stdin', io.StringIO(command)), patch.object(worker, 'verify_native_permissions'), patch.object(worker, 'emit', events.append):
            self.assertEqual(worker.main(), 0)
        self.assertEqual(harness.runs, 1)
        self.assertEqual([event['type'] for event in events], ['phase', 'ready', 'phase', 'result'])

    def test_first_initialization_failure_recovers_before_prompt(self):
        class Harness:
            starts = 0
            closes = 0

            def start(self):
                self.starts += 1
                if self.starts == 1:
                    raise RuntimeError('transient bootstrap failure')

            def close(self):
                self.closes += 1

        harness = Harness()
        worker.initialize_harness(harness)
        self.assertEqual((harness.starts, harness.closes), (2, 1))

    def test_persistent_failure_is_bounded_and_closed(self):
        class Harness:
            starts = 0
            closes = 0

            def start(self):
                self.starts += 1
                raise RuntimeError('persistent failure')

            def close(self):
                self.closes += 1

        harness = Harness()
        with self.assertRaises(RuntimeError):
            worker.initialize_harness(harness)
        self.assertEqual((harness.starts, harness.closes), (2, 2))

    def test_error_classification_never_returns_raw_details(self):
        self.assertEqual(worker.execution_error_code(RuntimeError('private prompt and token')), 'execution')
        self.assertEqual(worker.execution_error_code(RuntimeError('EPERM: private/path')), 'sandbox-permission')
        self.assertEqual(worker.execution_error_code(RuntimeError('Unsupported or malformed image data.')), 'invalid-image')


class PermissionVerificationTests(unittest.TestCase):
    def test_ack_requires_current_process_session_and_preset(self):
        session = SimpleNamespace(id='session', get_working_directory=lambda: '/tmp')
        for value in (['old', 'session', 'read-only'], ['nonce', 'other', 'read-only'], ['nonce', 'session', 'workspace-write']):
            harness = SimpleNamespace(client=SimpleNamespace(_stderr_lines=['AGENTLINK_PERMISSION ' + json.dumps(value)]))
            with self.assertRaises(worker.PermissionVerificationError):
                worker.verify_native_permissions(harness, session, 'nonce', 'read-only', timeout=0)
        harness.client._stderr_lines.append('AGENTLINK_PERMISSION ' + json.dumps(['nonce', 'session', 'read-only']))
        worker.verify_native_permissions(harness, session, 'nonce', 'read-only', timeout=0)

    def test_missing_plugin_prevents_model_execution(self):
        events = []
        session = SimpleNamespace(id='session', get_working_directory=lambda: '/tmp',
                                  run=lambda *_args, **_kwargs: self.fail('model must not run'))
        harness = SimpleNamespace(start=lambda: None, close=lambda: None,
                                  start_session=lambda _id: session, client=SimpleNamespace(_stderr_lines=[]))
        modules = {
            'deepseek_harness': SimpleNamespace(DeepSeekHarness=lambda **_kwargs: harness),
            'deepseek_harness_runtime': SimpleNamespace(bundled_runtime_path=lambda: Path('/tmp/runtime')),
        }
        env = {'DSH_PROXY_TOKEN': 'fixture', 'DSH_PROXY_BASE_URL': 'http://127.0.0.1:1', 'DSH_CHAT_ONLY_PATCH': '/tmp/patch'}
        command = json.dumps({'type': 'chat', 'sessionId': 'session', 'message': 'do not execute'}) + '\n'
        with patch.dict('sys.modules', modules), patch.dict(os.environ, env), patch('sys.stdin', io.StringIO(command)), patch.object(worker, 'emit', events.append), patch.object(worker.time, 'monotonic', side_effect=[0, 3]):
            self.assertEqual(worker.main(), 0)
        self.assertEqual(events[-1]['code'], 'permission-verification')
        self.assertNotIn('harness-run', [event.get('phase') for event in events])


class NativeResumeTests(unittest.TestCase):
    def test_restored_turn_uses_native_resume_without_creating_an_empty_session(self):
        events, resumed = [], []
        class Harness:
            def start(self): pass
            def close(self): pass
            def start_session(self, _id): raise AssertionError('must explicitly resume persisted history')
            def resume_session(self, session_id):
                resumed.append(session_id)
                return SimpleNamespace(run=lambda *_args, **_kwargs: SimpleNamespace(final_response='restored', finish_reason='completed', events=[]))
        modules = {
            'deepseek_harness': SimpleNamespace(DeepSeekHarness=lambda **_kwargs: Harness()),
            'deepseek_harness_runtime': SimpleNamespace(bundled_runtime_path=lambda: Path('/tmp/runtime')),
        }
        env = {'DSH_PROXY_TOKEN': 'fixture', 'DSH_PROXY_BASE_URL': 'http://127.0.0.1:1',
               'DSH_CHAT_ONLY_PATCH': '/tmp/patch', 'DSH_SESSION_EPOCH': 'stable-epoch'}
        command = json.dumps({'type': 'chat', 'sessionId': 'fixture-session', 'message': 'continue', 'resume': True}) + '\n'
        with patch.dict('sys.modules', modules), patch.dict(os.environ, env), patch('sys.stdin', io.StringIO(command)), patch.object(worker, 'verify_native_permissions'), patch.object(worker, 'emit', events.append):
            self.assertEqual(worker.main(), 0)
        self.assertEqual(resumed, ['fixture-session:wstable-epoch'])
        self.assertEqual(events[-1]['content'], 'restored')

if __name__ == '__main__':
    unittest.main()

"""Real pinned SDK: native permissions on a new session and after resume; local model only."""
from compression import zstd
import json
import os
import platform
import sys
import tempfile
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_runtime_path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'python'))
from sandbox_profile import macos_profile
class Model(BaseHTTPRequestHandler):
    action = None
    tool_results = []
    request_count = 0
    call_id = None
    next_id = 0
    def log_message(self, *_args): pass
    def do_POST(self):
        Model.request_count += 1
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        for message in body.get('messages', []):
            for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
                if block.get('type') == 'tool_result' and block.get('tool_use_id') == Model.call_id: Model.tool_results.append(block)
        events = [
            ('message_start', {'message': {'id': 'fixture', 'type': 'message', 'role': 'assistant', 'model': 'deepseek-v4-flash', 'content': [], 'usage': {'input_tokens': 1, 'output_tokens': 0}}}),
            ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': 'fixture-complete'}}),
            ('content_block_stop', {'index': 0}),
            ('message_delta', {'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}}),
            ('message_stop', {})]
        if Model.action is not None:
            name, arguments = Model.action
            Model.action = None
            events[1] = ('content_block_start', {'index': 0, 'content_block': {'type': 'tool_use', 'id': Model.call_id, 'name': name, 'input': {}}})
            events[2] = ('content_block_delta', {'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(arguments)}})
            events[4][1]['delta']['stop_reason'] = 'tool_use'
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for name, data in events:
            self.wfile.write(('event: '+name+'\ndata: '+json.dumps({'type': name, **data})+'\n\n').encode())

def call_tool(session, name, arguments):
    Model.next_id += 1
    Model.call_id = f'fixture-tool-{Model.next_id}'
    Model.tool_results = []
    Model.action = (name, arguments)
    session.run('Execute the fixture file operation.')
    assert Model.action is None, 'fixture tool was not requested'
    assert Model.tool_results, 'runtime did not return the requested tool result'
    return Model.tool_results[-1]

def main():
    if platform.system() != 'Darwin':
        raise RuntimeError('This boundary smoke requires the production macOS sandbox; Linux needs a Bubblewrap fixture.')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    saved = dict(os.environ)
    try:
        with tempfile.TemporaryDirectory(prefix='native-permission-smoke-') as directory, tempfile.TemporaryDirectory(prefix='native-permission-outside-') as outside, tempfile.NamedTemporaryFile(prefix='.framework-config-fixture-', suffix='.yaml', dir=ROOT, mode='w+') as framework_fixture:
            framework_fixture.write('synthetic-framework-secret')
            framework_fixture.flush()
            outside_file = Path(outside)/'sentinel.txt'
            outside_file.write_text('outside-private-fixture')
            home = Path(directory)
            patch = home/'permissions.yml'
            # Run with no real account credentials or inherited desktop home.
            os.environ.clear(); os.environ.update({'HOME': directory, 'DSH_HOME': directory, 'DSH_WORKSPACE': directory, 'PATH': '/usr/bin:/bin', 'DSH_PERMISSION_MODE': 'read-only', 'TMPDIR': directory})
            from dsh_worker import verify_native_permissions, PermissionVerificationError
            results = []
            for index, preset in enumerate(['workspace-write', 'read-only', 'workspace-write']):
                patch.write_text('- insert:\n    - id: agent-link-native-permissions\n      name: '+json.dumps(str(ROOT/'python/native_permissions.mjs'))+'\n      config:\n        preset: '+preset+'\n')
                runtime = bundled_runtime_path()
                launch = (str(runtime), '--profile', 'sdk', '--patch', str(patch))
                if platform.system() == 'Darwin':
                    profile = macos_profile(home, home, runtime, Path(sys.prefix), ROOT/'python/dsh_worker.py', patch, server.server_port)
                    launch = ('/usr/bin/sandbox-exec', '-p', profile, *launch)
                with DeepSeekHarness(env={'AGENTLINK_PERMISSION_NONCE': 'fixture-nonce'}, _launch_args=launch, dsh_home=directory, cwd=directory, dsh_bin=str(bundled_runtime_path()), patches=(str(patch),), api_key='fixture', base_url=f'http://127.0.0.1:{server.server_port}', request_timeout_seconds=20) as harness:
                    session = harness.start_session('permission-resume') if index == 0 else harness.resume_session('permission-resume')
                    verify_native_permissions(harness, session, 'fixture-nonce', preset)
                    result = session.run('Reply with fixture-complete.')
                    assert result.final_response == 'fixture-complete', result.final_response
                    target = home/f'write-{index}.txt'
                    outcome = call_tool(session, 'write', {'file_path': str(target), 'content': 'allowed-fixture'})
                    assert target.exists() == (preset == 'workspace-write'), (preset, outcome)
                    assert bool(outcome.get('is_error')) == (preset == 'read-only'), outcome
                    if preset == 'read-only':
                        escalated = call_tool(session, 'write', {
                            'file_path': str(target), 'content': 'unexpected-readonly-escalation',
                            'sandbox_permissions': 'workspace-write',
                            'justification': 'Fixture verifies write access requires approval.'})
                        assert escalated.get('is_error') and not target.exists(), escalated
                    if target.exists():
                        assert target.read_text() == 'allowed-fixture'
                        outcome = call_tool(session, 'read', {'file_path': str(target)})
                        assert not outcome.get('is_error') and 'allowed-fixture' in json.dumps(outcome), outcome
                    link = home/f'outside-link-{index}'
                    link.symlink_to(outside_file)
                    for path in (outside_file, link, Path(framework_fixture.name)):
                        outcome = call_tool(session, 'write', {'file_path': str(path), 'content': 'unexpected-write'})
                        assert outcome.get('is_error'), outcome
                        assert outside_file.read_text() == 'outside-private-fixture'
                        outcome = call_tool(session, 'read', {'file_path': str(path)})
                        assert outcome.get('is_error') and 'outside-private-fixture' not in json.dumps(outcome) and 'synthetic-framework-secret' not in json.dumps(outcome), 'outside or framework fixture read was not blocked'
                    # No UI approval bridge is installed: an explicit wider retry
                    # must not turn ask into an automatic grant.
                    escalated = call_tool(session, 'write', {
                        'file_path': str(outside_file), 'content': 'unexpected-escalation',
                        'sandbox_permissions': 'danger-full-access',
                        'justification': 'Fixture verifies an unapproved retry is rejected.'})
                    assert escalated.get('is_error'), escalated
                    assert outside_file.read_text() == 'outside-private-fixture'
                    assert not any('did not activate' in line for line in harness._client._stderr_lines), list(harness._client._stderr_lines)
                # Read only the isolated fixture's durable records, never production history.
                modes, approvals = [], []
                for path in (home/'sessions').rglob('*'):
                    if not path.is_file(): continue
                    data = path.read_bytes()
                    if data.startswith(b'\x28\xb5\x2f\xfd'): data = zstd.decompress(data)
                    try: text = data.decode('utf8')
                    except UnicodeDecodeError: continue
                    for line in text.splitlines():
                        try: event=json.loads(line)
                        except ValueError: continue
                        if event.get('type') == 'sandbox/mode': modes.append(event)
                        if event.get('type') == 'approval/policy': approvals.append(event)
                assert modes and max(modes, key=lambda e:e['seq'])['data']['mode'] == preset, modes
                assert approvals and max(approvals, key=lambda e:e['seq'])['data']['policy'] == 'ask', approvals
                results.append({'preset': preset, 'resumed': index > 0, 'verifiedNativeMode': preset, 'approval': 'ask', 'modeEventCount': len(modes), 'fileBoundariesVerified': True})
            # SDK can start with no permission adapter: the production guard must
            # refuse that session before any request reaches the local model.
            patch.write_text('[]\n')
            before = Model.request_count
            with DeepSeekHarness(env={'AGENTLINK_PERMISSION_NONCE': 'missing-plugin-nonce'}, _launch_args=launch, dsh_home=directory, cwd=directory, api_key='fixture', base_url=f'http://127.0.0.1:{server.server_port}') as harness:
                session = harness.start_session('missing-permission-plugin')
                try:
                    verify_native_permissions(harness, session, 'missing-plugin-nonce', 'read-only', timeout=0.2)
                except PermissionVerificationError:
                    pass
                else:
                    raise AssertionError('missing adapter was accepted')
            assert Model.request_count == before, 'permission check sent a model request'
            print(json.dumps({'sessions': results, 'missingPluginBlockedBeforeModel': True, 'symlinkEscapeBlocked': True, 'unapprovedEscalationBlocked': True}, ensure_ascii=False))
    finally:
        os.environ.clear(); os.environ.update(saved)
        server.shutdown(); server.server_close(); thread.join()
if __name__ == '__main__': main()

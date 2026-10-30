"""Optional real SDK smoke: preinstalled --home, local model fixture, no model key.

Run with the project's DSH virtualenv. On macOS the runtime uses the production
OS sandbox policy. This validates plugin execution, not a real model or QQ send.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from sandbox_profile import macos_profile
from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_runtime_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True, help='isolated DSH home with the reviewed plugin already installed')
    parser.add_argument('--utilities', action='store_true', help='also test unit conversion and real read-only npm discovery')
    args = parser.parse_args()
    home = Path(args.home).resolve()
    policy_file = home / 'smoke-policy.yml'
    original = (Path(__file__).resolve().parents[1] / 'python/chat_only.patch.yml').read_text()
    policy_file.write_text(original)
    calls = []
    cases = [
        ('visualize', {'fragment': '<div><h2>SDK smoke</h2><p>2 + 2 = 4</p></div>', 'title': 'SDK smoke'}),
        ('visualize', {'action': 'update', 'path': '/etc/passwd', 'title': 'denied', 'old_str': 'root', 'new_str': 'changed'})
    ]
    if args.utilities:
        cases += [
            ('convert', {'value': 1, 'from': 'km', 'to': 'm'}),
            ('convert', {'value': 20, 'from': 'C', 'to': 'F'}),
            ('convert', {'value': 10, 'from': 'ΔC', 'to': 'ΔF'}),
            ('convert', {'value': 1, 'from': 'm', 'to': 's'}),
            ('plugin_search', {'query': 'dsh-unitverse', 'limit': 1})
        ]

    class ModelFixture(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append(body)
            names = [tool.get('function', tool).get('name') for tool in body.get('tools', [])]
            assert 'visualize' in names, names
            assert 'plugin_manager' not in names and 'skill' not in names, names
            assert {name for name, _ in cases}.issubset(names), names
            assert len(calls) <= len(cases) + 1, 'unexpected tool retry'
            tool_name, tool_args = cases[len(calls) - 1] if len(calls) <= len(cases) else ('', {})
            events = [('message_start', {'message': {'id': 'fixture', 'type': 'message', 'role': 'assistant',
                'model': 'deepseek-v4-flash', 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}})]
            if len(calls) <= len(cases):
                events += [('content_block_start', {'index': 0, 'content_block': {'type': 'tool_use', 'id': f'viz-{len(calls)}', 'name': tool_name, 'input': {}}}),
                    ('content_block_delta', {'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(tool_args)}})]
            else:
                events += [('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                    ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': 'verified'}})]
            events += [('content_block_stop', {'index': 0}), ('message_delta', {'delta': {'stop_reason': 'tool_use' if len(calls) <= len(cases) else 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 10}}), ('message_stop', {})]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for name, payload in events:
                self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps({'type': name, **payload}) + '\n\n').encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    runtime = bundled_runtime_path()
    launch = (str(runtime), '--profile', 'sdk', '--patch', str(policy_file))
    if platform.system() == 'Darwin':
        policy = macos_profile(home, home, runtime, Path(sys.prefix), Path(__file__), policy_file, server.server_port, args.utilities)
        launch = ('/usr/bin/sandbox-exec', '-p', policy, *launch)
    # Do not pass the host's model or account credentials to the SDK child.
    saved_env = dict(os.environ)
    os.environ.clear()
    os.environ.update({'HOME': str(home), 'DSH_HOME': str(home), 'PATH': '/usr/bin:/bin', 'DSH_PERMISSION_MODE': 'read-only'})
    try:
        with DeepSeekHarness(_launch_args=launch, dsh_home=str(home), cwd=str(home), api_key='fixture-not-a-key',
                             base_url=f'http://127.0.0.1:{server.server_port}', request_timeout_seconds=60) as harness:
            result = harness.run('Create a smoke HTML card, then test rejection of an out-of-store update.')
        results = [event['data'] for event in result.events if event['type'] == 'tool/result']
        assert result.finish_reason == 'completed', result.finish_reason
        assert len(results) == len(cases), results
        assert results[0]['message'].get('isError') is False, results[0]
        assert results[1]['message'].get('isError') is True, results[1]
        card_path = results[0]['meta']['path'].replace('~/', str(home) + '/', 1)
        card = Path(card_path)
        assert card.is_file() and '2 + 2 = 4' in card.read_text()
        if args.utilities:
            for index, expected in ((2, '= 1000'), (3, '= 68'), (4, '= 18')):
                message = results[index]['message']
                assert message.get('isError') is False, message
                assert expected in json.dumps(message, ensure_ascii=False), message
            assert results[5]['message'].get('isError') is True, results[5]
            search = results[6]['message']
            assert search.get('isError') is False, search
            search_text = '\n'.join(item.get('text', '') for item in search['content'])
            assert 'dsh-unitverse' in search_text and '可安装' in search_text, search_text
        print(json.dumps({'sdk': 'passed', 'htmlCreated': True, 'utilities': args.utilities, 'outsidePathRejected': True,
                          'osSandbox': platform.system() == 'Darwin', 'model': 'local fixture', 'qqDelivery': 'not tested'}))
    finally:
        os.environ.clear(); os.environ.update(saved_env)
        server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    main()

"""Real SDK registry under the production tool policy; no real credentials."""
import io
import json
import os
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_runtime_path
from smoke_native_permissions import Model

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))


class Probe(Model):
    names = set()

    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        body = json.loads(data)
        self.names.update(tool['name'] for tool in body.get('tools', []))
        self.rfile = io.BytesIO(data)
        super().do_POST()


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Probe)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    saved = dict(os.environ)
    try:
        with tempfile.TemporaryDirectory(prefix='strict-tool-policy-') as directory:
            home = Path(directory)
            os.environ.clear()
            os.environ.update({'HOME': directory, 'DSH_HOME': directory, 'TMPDIR': directory,
                               'DSH_WORKSPACE_ROOT': directory, 'DSH_HOME_ROOT': directory,
                               'PATH': saved.get('PATH', '/usr/bin:/bin')})
            import dsh_bridge
            patch = home / 'strict.yml'
            caps = dict(chat=True, web=True, files=True, terminal=True)
            patch.write_text(dsh_bridge.tool_policy_patch(caps) + dsh_bridge.native_permission_patch(caps))
            with DeepSeekHarness(dsh_home=directory, cwd=directory, dsh_bin=str(bundled_runtime_path()),
                                 patches=(str(patch),), api_key='fixture',
                                 base_url=f'http://127.0.0.1:{server.server_port}', request_timeout_seconds=30) as harness:
                result = harness.start_session().run('Report readiness.')
                assert result.final_response == 'fixture-complete'
            # No framework MCP or approved plugin is attached in this fixture:
            # The runtime retains a plan-mode control, which cannot restore the
            # disabled file/shell/web plugins. No general operation may remain.
            operation_tools = Probe.names - {'exit_plan_mode'}
            assert not operation_tools, sorted(operation_tools)
            print(json.dumps({'allCapabilitiesGranted': True, 'generalToolsRegistered': sorted(operation_tools), 'controlTools': sorted(Probe.names)}))
    finally:
        os.environ.clear()
        os.environ.update(saved)
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()

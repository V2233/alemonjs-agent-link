"""Build the macOS sandbox-exec profile used for an isolated group worker."""
import sys
from pathlib import Path

def macos_profile(workspace: Path, dsh_home: Path, runtime: Path, python_root: Path, worker_script: Path, chat_only_patch: Path, proxy_port: int, allow_web: bool = False) -> str:
    """Return a deny-by-default profile for one worker.

    Keep the worker program itself explicit: it lives alongside the bridge and
    must not cause us to grant the worker read access to the whole plugin tree.
    """
    writable = [workspace.resolve(), dsh_home.resolve()]
    readonly = [runtime.resolve().parent, python_root.resolve(), Path('/System'), Path('/usr'), Path('/opt/homebrew')]
    python_runtime = Path(sys.executable).resolve().parents[1]
    write_rules = "\n".join(f'(allow file-read* file-write* (subpath "{path}"))' for path in writable)
    read_rules = "\n".join(f'(allow file-read* (subpath "{path}"))' for path in readonly)
    metadata_paths = [Path(sys.executable).resolve(), runtime.resolve(), worker_script.resolve(), chat_only_patch.resolve(), *writable, *readonly]
    metadata_rules = "\n".join(f'(allow file-read-metadata file-test-existence (path-ancestors "{path}"))' for path in metadata_paths)
    return f'''(version 1)
(import "system.sb")
(deny default)
(allow process-fork)
(allow signal (target children))
(allow process-exec (subpath "{python_runtime}"))
(allow process-exec (subpath "{runtime.resolve().parent}"))
(allow file-read* (literal "{worker_script.resolve()}"))
(allow file-read* (literal "{chat_only_patch.resolve()}"))
(allow network-outbound (remote tcp "localhost:{proxy_port}"))
{'(allow network-outbound)' if allow_web else ''}
(allow file-read* file-write* (subpath "/dev"))
{write_rules}
{read_rules}
{metadata_rules}
'''

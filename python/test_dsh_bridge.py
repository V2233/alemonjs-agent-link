import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest


def load_bridge():
    root = Path(tempfile.mkdtemp(prefix='agent-link-bridge-test-'))
    module_dir = str(Path(__file__).parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    os.environ.update({
        'DSH_WORKSPACE_ROOT': str(root / 'workspaces'),
        'DSH_HOME_ROOT': str(root / 'homes'),
        'DSH_BRIDGE_TOKEN': 'test-token'
    })
    spec = importlib.util.spec_from_file_location('dsh_bridge_test', Path(__file__).with_name('dsh_bridge.py'))
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
            def __init__(self, key, _port):
                self.key = key
                self.lock = threading.Lock()
                self.last_used = 0
                self.stopped = False

            def stop(self):
                self.stopped = True

        original_worker = self.bridge.Worker
        try:
            self.bridge.Worker = FakeWorker
            self.bridge.MAX_ACTIVE_WORKERS = 1
            idle = FakeWorker('a' * 64, 1)
            self.bridge.WORKERS = {idle.key: idle}

            replacement = self.bridge.get_worker('b' * 64, 1)

            self.assertTrue(idle.stopped)
            self.assertEqual(replacement.key, 'b' * 64)
            self.assertEqual(set(self.bridge.WORKERS), {'b' * 64})

            replacement.lock.acquire()
            with self.assertRaises(self.bridge.WorkerCapacityError):
                self.bridge.get_worker('c' * 64, 1)
            replacement.lock.release()
        finally:
            self.bridge.Worker = original_worker


if __name__ == '__main__':
    unittest.main()

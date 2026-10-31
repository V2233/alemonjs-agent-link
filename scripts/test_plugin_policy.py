import json
import base64
import hashlib
import io
import tarfile
from pathlib import Path
import sys
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from plugin_policy import prepare_plugins, validate_plugins, reviewed_archive, plugin_specs, reviewed_download, warm_reviewed_plugins


class PluginPolicyTests(unittest.TestCase):
    def archive(self, manifest, extra=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            data = json.dumps(manifest).encode()
            member = tarfile.TarInfo('package/package.json'); member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(tarfile.TarInfo(extra), io.BytesIO(b''))
        data = buffer.getvalue()
        return data, 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()

    def test_reviewed_archive_rejects_changed_bytes(self):
        data, integrity = self.archive({'name': 'demo'})
        reviewed_archive(data, integrity)
        with self.assertRaisesRegex(ValueError, 'integrity'):
            reviewed_archive(data + b'changed', integrity)

    def test_reviewed_archive_rejects_unreviewed_dependencies_and_scripts(self):
        for manifest in ({'dependencies': {'evil': '*'}}, {'optionalDependencies': {'evil': '*'}}, {'scripts': {'install': 'anything'}}):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                reviewed_archive(*self.archive(manifest))

    def test_reviewed_archive_rejects_traversal(self):
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            reviewed_archive(*self.archive({}, 'package/../../outside'))

    def test_reviewed_archive_rejects_duplicate_manifest(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            reviewed_archive(*self.archive({}, 'package/package.json'))

    def test_reviewed_cache_reuses_verified_bytes_without_network(self):
        data, integrity = self.archive({'name': 'demo'})
        reviewed = {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}
        with tempfile.TemporaryDirectory() as cache:
            with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)) as fetch:
                self.assertEqual(reviewed_download(reviewed, cache), data)
                fetch.assert_called_once()
            with patch('plugin_policy.urllib.request.urlopen') as fetch:
                self.assertEqual(reviewed_download(reviewed, cache), data)
                fetch.assert_not_called()

    def test_reviewed_cache_repairs_corruption_and_does_not_follow_links(self):
        data, integrity = self.archive({'name': 'demo'})
        reviewed = {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as cache:
                directory = Path(cache) / 'reviewed-archives'; directory.mkdir()
                target = directory / (hashlib.sha256(integrity.encode()).hexdigest() + '.tgz')
                sentinel = Path(cache) / 'sentinel'; sentinel.write_bytes(b'private')
                if linked:
                    target.symlink_to(sentinel)
                else:
                    target.write_bytes(b'corrupt')
                with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)) as fetch:
                    self.assertEqual(reviewed_download(reviewed, cache), data)
                    fetch.assert_called_once()
                self.assertFalse(target.is_symlink())
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual(sentinel.read_bytes(), b'private')

    def test_reviewed_cache_does_not_publish_unverified_download(self):
        _, integrity = self.archive({'name': 'demo'})
        reviewed = {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}
        with tempfile.TemporaryDirectory() as cache:
            with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(b'changed')):
                with self.assertRaisesRegex(ValueError, 'integrity'):
                    reviewed_download(reviewed, cache)
            self.assertEqual(list((Path(cache) / 'reviewed-archives').iterdir()), [])

    def test_concurrent_prefetch_and_worker_share_one_download(self):
        data, integrity = self.archive({'name': 'demo'})
        reviewed = {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}
        entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
        def fetch(*args, **kwargs):
            entered.set()
            if not release.wait(2): raise AssertionError('fixture download not released')
            return io.BytesIO(data)
        def second(cache):
            second_started.set()
            return reviewed_download(reviewed, cache)
        with tempfile.TemporaryDirectory() as cache, patch('plugin_policy.urllib.request.urlopen', side_effect=fetch) as download, ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(reviewed_download, reviewed, cache)
            try:
                self.assertTrue(entered.wait(2))
                other = pool.submit(second, cache)
                self.assertTrue(second_started.wait(2))
            finally:
                release.set()
            self.assertEqual(first.result(timeout=2), data)
            self.assertEqual(other.result(timeout=2), data)
            download.assert_called_once()

    def test_download_failure_cools_down_then_recovers(self):
        data, integrity = self.archive({'name': 'demo'})
        reviewed = {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}
        with tempfile.TemporaryDirectory() as cache, patch('plugin_policy.time.monotonic', return_value=100) as clock:
            with patch('plugin_policy.urllib.request.urlopen', side_effect=OSError('network unavailable')) as download:
                with self.assertRaises(OSError): reviewed_download(reviewed, cache)
                with self.assertRaisesRegex(RuntimeError, 'cooling down'): reviewed_download(reviewed, cache)
                download.assert_called_once()
            clock.return_value = 131
            with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)) as download:
                self.assertEqual(reviewed_download(reviewed, cache), data)
                download.assert_called_once()
            with patch('plugin_policy.urllib.request.urlopen') as download:
                self.assertEqual(reviewed_download(reviewed, cache), data)
                download.assert_not_called()

    def test_one_failed_package_does_not_cool_down_other_packages(self):
        data, integrity = self.archive({'name': 'other'})
        failed = {'tarball': 'https://registry.npmjs.org/failed.tgz', 'integrity': 'sha512-failed'}
        good = {'tarball': 'https://registry.npmjs.org/other.tgz', 'integrity': integrity}
        with tempfile.TemporaryDirectory() as cache, patch('plugin_policy.urllib.request.urlopen', side_effect=[OSError('offline'), io.BytesIO(data)]):
            with self.assertRaises(OSError): reviewed_download(failed, cache)
            self.assertEqual(reviewed_download(good, cache), data)

    def test_reviewed_plugin_upgrade_requires_new_review(self):
        for name in ('@nagi-ovo/dsh-visualize', 'dsh-unitverse', 'dsh-plugin-search'):
            with self.subTest(name=name), patch('plugin_policy.urllib.request.urlopen') as fetch, self.assertRaisesRegex(ValueError, 'not been reviewed'):
                plugin_specs('/tmp', [{'name': name, 'version': '999.0.0'}])
            fetch.assert_not_called()

    def test_unknown_pinned_plugin_is_not_an_implicit_review_grant(self):
        with patch('plugin_policy.urllib.request.urlopen') as fetch:
            with self.assertRaisesRegex(ValueError, 'not been reviewed'):
                plugin_specs('/tmp', [{'name': 'unknown-package', 'version': '1.0.0'}])
            fetch.assert_not_called()

    def test_rejects_unpinned_and_non_registry_specs(self):
        for value in (None, {}, [{'name': 'github:someone/repo', 'version': '1.0.0'}],
                      [{'name': 'demo', 'version': 'latest'}], [{'name': 'demo', 'version': '^1.0.0'}],
                      [{'name': 'demo', 'version': '1.0.0', 'config': {}}],
                      [{'name': '@deepseek-ai/dsh-base', 'version': '1.0.0'}],
                      [{'name': 'demo', 'version': '1.0.0'}] * 2):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_plugins(value)
        self.assertEqual(validate_plugins([{'name': '@example/demo', 'version': '0.2.1-rc.2'}])[0]['version'], '0.2.1-rc.2')

    def test_no_install_without_all_owner_workspace_permissions(self):
        plugins = [{'name': 'demo', 'version': '1.0.0'}]
        for denied in ('web', 'files', 'terminal'):
            caps = dict(web=True, files=True, terminal=True)
            caps[denied] = False
            with patch('plugin_policy.subprocess.Popen') as spawn:
                self.assertEqual(prepare_plugins('/runtime', '/home', 'sdk', plugins, caps), [])
                spawn.assert_not_called()

    def test_revocation_removes_previous_native_plugin_profile(self):
        approved = [{'name': 'demo', 'version': '1.0.0'}]
        for revoked in ('web', 'files', 'terminal', 'allowlist'):
            with self.subTest(revoked=revoked), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                profile = home / 'profiles/sdk'; profile.mkdir(parents=True)
                (profile / 'package.json').write_text('{"dsh":{"profile":{"bundles":["demo"]}}}')
                capabilities = dict(web=True, files=True, terminal=True)
                plugins = approved
                if revoked == 'allowlist':
                    plugins = []
                else:
                    capabilities[revoked] = False
                with patch('plugin_policy.subprocess.Popen') as spawn:
                    self.assertEqual(prepare_plugins('/runtime', home, 'sdk', plugins, capabilities), [])
                    spawn.assert_not_called()
                self.assertFalse((home / 'profiles').exists())

    def test_revocation_unlinks_profile_without_deleting_external_target(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            home = Path(directory)
            sentinel = Path(outside) / 'private'; sentinel.write_text('unchanged')
            (home / 'profiles').symlink_to(outside)
            prepare_plugins('/runtime', home, 'sdk', [], {})
            self.assertFalse((home / 'profiles').is_symlink())
            self.assertEqual(sentinel.read_text(), 'unchanged')

    def test_prefetch_only_downloads_reviewed_exact_versions_and_continues_after_failure(self):
        plugins = [{'name': 'dsh-unitverse', 'version': '1.1.4'},
                   {'name': 'dsh-plugin-search', 'version': '0.5.0'},
                   {'name': 'unknown', 'version': '1.0.0'},
                   {'name': '@nagi-ovo/dsh-visualize', 'version': '999.0.0'}]
        with patch('plugin_policy.reviewed_download', side_effect=[OSError('private detail'), b'ok']) as download, patch('plugin_policy.subprocess.Popen') as spawn:
            result = warm_reviewed_plugins(plugins, '/cache')
        self.assertEqual(result, {'dsh-unitverse@1.1.4': 'failed', 'dsh-plugin-search@0.5.0': 'ready'})
        self.assertEqual(download.call_count, 2)
        spawn.assert_not_called()

    def test_native_preparation_restores_independent_profiles_without_reinstall(self):
        plugins = [{'name': 'demo', 'version': '1.0.0'}]
        data, integrity = self.archive({'name': 'demo', 'version': '1.0.0', 'dsh': {'bundle': {'patch': './cordis.patch.yml'}}})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime = root / 'runtime'; runtime.write_bytes(b'fixture')
            cache = root / 'cache'; cache.mkdir()
            (root / 'plugin_catalog.json').write_text(json.dumps({'demo@1.0.0': {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}}))
            with patch('plugin_policy.__file__', str(root / 'plugin_policy.py')):
                with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)), patch('plugin_policy._install_plugins', return_value=['demo']) as install:
                    self.assertEqual(warm_reviewed_plugins(plugins, cache, runtime), {'demo@1.0.0': 'ready'})
                    install.assert_called_once()
                first, second = root / 'first', root / 'second'
                first.mkdir(); second.mkdir()
                with patch('plugin_policy.subprocess.Popen') as spawn, patch('plugin_policy.urllib.request.urlopen') as fetch:
                    self.assertEqual(prepare_plugins(runtime, first, 'sdk', plugins, dict(web=True, files=True, terminal=True)), ['demo'])
                    package = Path('profiles/sdk/node_modules/demo/package.json')
                    (first / package).write_text('tampered by a prior session')
                    self.assertEqual(prepare_plugins(runtime, second, 'sdk', plugins, dict(web=True, files=True, terminal=True)), ['demo'])
                    self.assertEqual(json.loads((second / package).read_text())['name'], 'demo')
                    self.assertFalse((second / package).is_symlink())
                    self.assertEqual(prepare_plugins(runtime, second, 'sdk', plugins, dict(web=True, files=True, terminal=False)), [])
                    self.assertFalse((second / 'profiles').exists())
                    spawn.assert_not_called(); fetch.assert_not_called()
                from plugin_policy import restore_prepared_plugins
                runtime.write_bytes(b'updated SDK runtime')
                self.assertFalse(restore_prepared_plugins(runtime, second, plugins))

    def test_failed_native_compatibility_check_never_publishes_prepared_profile(self):
        from plugin_policy import restore_prepared_plugins
        plugins = [{'name': 'demo', 'version': '1.0.0'}]
        data, integrity = self.archive({'name': 'demo', 'version': '1.0.0'})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime = root / 'runtime'; runtime.write_bytes(b'fixture')
            cache = root / 'cache'; cache.mkdir()
            (root / 'plugin_catalog.json').write_text(json.dumps({'demo@1.0.0': {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}}))
            with patch('plugin_policy.__file__', str(root / 'plugin_policy.py')):
                with patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)), patch('plugin_policy._install_plugins', side_effect=RuntimeError('incompatible')):
                    self.assertEqual(warm_reviewed_plugins(plugins, cache, runtime), {'demo@1.0.0': 'failed'})
                self.assertFalse(restore_prepared_plugins(runtime, root, plugins))

    def test_native_install_pins_versions_and_activates_only_approved_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            profile = home / 'profiles/sdk'
            def spawn(command, **kwargs):
                self.assertEqual(command, ['/runtime', 'plugin', '--profile', 'sdk', 'add', '--save-exact', '--ignore-scripts', 'demo@1.0.0'])
                self.assertNotIn('DEEPSEEK_API_KEY', kwargs['env'])
                self.assertNotIn('DSH_BRIDGE_TOKEN', kwargs['env'])
                package = profile / 'node_modules/demo'
                package.mkdir(parents=True)
                (package / 'package.json').write_text(json.dumps({'name': 'demo', 'version': '1.0.0', 'dsh': {'bundle': {'patch': './cordis.patch.yml'}}}))
                (profile / 'package.json').write_text(json.dumps({'dsh': {'profile': {'bundles': ['unexpected']}}}))
                class Process:
                    def wait(self, timeout=None): return 0
                return Process()
            with patch('plugin_policy.plugin_specs', return_value=['demo@1.0.0']), patch('plugin_policy.subprocess.Popen', side_effect=spawn), patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'secret', 'DSH_BRIDGE_TOKEN': 'secret'}):
                self.assertEqual(prepare_plugins('/runtime', home, 'sdk', [{'name': 'demo', 'version': '1.0.0'}], dict(web=True, files=True, terminal=True)), ['demo'])
            settings = json.loads((profile / 'package.json').read_text())['dsh']['profile']
            self.assertEqual(settings['bundles'], ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', 'demo'])
            self.assertEqual(settings['patchReload'], 'startup')

    def test_background_and_foreground_share_native_install(self):
        plugins = [{'name': 'demo', 'version': '1.0.0'}]
        data, integrity = self.archive({'name': 'demo', 'version': '1.0.0'})
        entered, release, foreground_started = threading.Event(), threading.Event(), threading.Event()
        def install(*args):
            entered.set()
            if not release.wait(2): raise AssertionError('native fixture not released')
            return ['demo']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime = root / 'runtime'; runtime.write_bytes(b'fixture')
            cache = root / 'cache'; cache.mkdir()
            home = root / 'worker'; home.mkdir()
            (root / 'plugin_catalog.json').write_text(json.dumps({'demo@1.0.0': {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}}))
            def foreground():
                foreground_started.set()
                return prepare_plugins(runtime, home, 'sdk', plugins, dict(web=True, files=True, terminal=True), cache)
            with patch('plugin_policy.__file__', str(root / 'plugin_policy.py')), patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)), patch('plugin_policy._install_plugins', side_effect=install) as native, ThreadPoolExecutor(max_workers=2) as pool:
                background = pool.submit(warm_reviewed_plugins, plugins, cache, runtime)
                try:
                    self.assertTrue(entered.wait(2))
                    request = pool.submit(foreground)
                    self.assertTrue(foreground_started.wait(2))
                finally:
                    release.set()
                self.assertEqual(background.result(timeout=2), {'demo@1.0.0': 'ready'})
                self.assertEqual(request.result(timeout=2), ['demo'])
                native.assert_called_once()
                self.assertEqual(json.loads((home / 'profiles/sdk/node_modules/demo/package.json').read_text())['name'], 'demo')

    def test_native_failure_recovers_and_changed_runtime_cannot_publish(self):
        from plugin_policy import restore_prepared_plugins
        plugins = [{'name': 'demo', 'version': '1.0.0'}]
        data, integrity = self.archive({'name': 'demo', 'version': '1.0.0'})
        for changed in (False, True):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); runtime = root / 'runtime'; runtime.write_bytes(b'fixture')
                cache = root / 'cache'; cache.mkdir()
                home = root / 'worker'; home.mkdir()
                (root / 'plugin_catalog.json').write_text(json.dumps({'demo@1.0.0': {'tarball': 'https://registry.npmjs.org/demo.tgz', 'integrity': integrity}}))
                def install(*args):
                    if changed: runtime.write_bytes(b'new runtime')
                    return ['demo']
                with patch('plugin_policy.__file__', str(root / 'plugin_policy.py')), patch('plugin_policy.time.monotonic', return_value=100) as clock, patch('plugin_policy.urllib.request.urlopen', return_value=io.BytesIO(data)):
                    if not changed:
                        with patch('plugin_policy._install_plugins', side_effect=RuntimeError('offline')) as native:
                            self.assertEqual(warm_reviewed_plugins(plugins, cache, runtime), {'demo@1.0.0': 'failed'})
                            with self.assertRaisesRegex(RuntimeError, 'cooling down'):
                                prepare_plugins(runtime, home, 'sdk', plugins, dict(web=True, files=True, terminal=True), cache)
                            native.assert_called_once()
                        clock.return_value = 131
                    with patch('plugin_policy._install_plugins', side_effect=install):
                        if changed:
                            with self.assertRaisesRegex(RuntimeError, 'inputs changed'):
                                prepare_plugins(runtime, home, 'sdk', plugins, dict(web=True, files=True, terminal=True), cache)
                            self.assertFalse(restore_prepared_plugins(runtime, home, plugins))
                        else:
                            self.assertEqual(prepare_plugins(runtime, home, 'sdk', plugins, dict(web=True, files=True, terminal=True), cache), ['demo'])
                            self.assertTrue(restore_prepared_plugins(runtime, home, plugins))

    def test_failure_does_not_leave_executable_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch('plugin_policy.plugin_specs', return_value=['demo@1.0.0']), patch('plugin_policy.subprocess.Popen') as spawn, patch('plugin_policy.os.killpg'):
                spawn.return_value.wait.return_value = 1
                with self.assertRaisesRegex(RuntimeError, 'installation failed'):
                    prepare_plugins('/runtime', home, 'sdk', [{'name': 'demo', 'version': '1.0.0'}], dict(web=True, files=True, terminal=True))
                self.assertFalse((home / 'profiles').exists())


if __name__ == '__main__':
    unittest.main()

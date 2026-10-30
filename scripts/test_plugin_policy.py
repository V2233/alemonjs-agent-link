import json
import base64
import hashlib
import io
import tarfile
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from plugin_policy import prepare_plugins, validate_plugins, reviewed_archive, plugin_specs


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

    def test_reviewed_plugin_upgrade_requires_new_review(self):
        for name in ('@nagi-ovo/dsh-visualize', 'dsh-unitverse', 'dsh-plugin-search'):
            with self.subTest(name=name), patch('plugin_policy.urllib.request.urlopen') as fetch, self.assertRaisesRegex(ValueError, 'not been reviewed'):
                plugin_specs('/tmp', [{'name': name, 'version': '999.0.0'}])
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
            with patch('plugin_policy.subprocess.Popen', side_effect=spawn), patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'secret', 'DSH_BRIDGE_TOKEN': 'secret'}):
                self.assertEqual(prepare_plugins('/runtime', home, 'sdk', [{'name': 'demo', 'version': '1.0.0'}], dict(web=True, files=True, terminal=True)), ['demo'])
            settings = json.loads((profile / 'package.json').read_text())['dsh']['profile']
            self.assertEqual(settings['bundles'], ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', 'demo'])
            self.assertEqual(settings['patchReload'], 'startup')

    def test_failure_does_not_leave_executable_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch('plugin_policy.subprocess.Popen') as spawn, patch('plugin_policy.os.killpg'):
                spawn.return_value.wait.return_value = 1
                with self.assertRaisesRegex(RuntimeError, 'installation failed'):
                    prepare_plugins('/runtime', home, 'sdk', [{'name': 'demo', 'version': '1.0.0'}], dict(web=True, files=True, terminal=True))
                self.assertFalse((home / 'profiles').exists())


if __name__ == '__main__':
    unittest.main()

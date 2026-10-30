"""Administrator-selected DSH bundles; never accept install specs from chat."""
import json
import base64
import hashlib
import io
import tarfile
import urllib.request
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess


def validate_plugins(value):
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError('dshPlugins must be an array of at most 8 entries')
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {'name', 'version'}:
            raise ValueError('DSH plugin requires only name and version')
        name, version = entry['name'], entry['version']
        if not isinstance(name, str) or not re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*', name) or len(name) > 214:
            raise ValueError('DSH plugin requires an exact npm package name')
        if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?', version):
            raise ValueError('DSH plugin requires a pinned version')
        if name in seen or name in ('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'):
            raise ValueError('duplicate or protected DSH plugin')
        seen.add(name)
    return value



def reviewed_archive(data, integrity):
    if 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() != integrity:
        raise ValueError('reviewed DSH plugin integrity mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package' or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe reviewed DSH plugin archive')
        manifest = json.load(archive.extractfile('package/package.json'))
        if manifest.get('dependencies') or manifest.get('optionalDependencies'):
            raise ValueError('reviewed plugin must not introduce unreviewed runtime dependencies')
        scripts = manifest.get('scripts', {})
        if any(name in scripts for name in ('preinstall', 'install', 'postinstall', 'prepare')):
            raise ValueError('reviewed plugin must not require install scripts')


def plugin_specs(home, plugins):
    catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
    specs = []
    for index, item in enumerate(plugins):
        spec = f"{item['name']}@{item['version']}"
        reviewed = catalog.get(spec)
        if reviewed is None:
            if any(key.rsplit('@', 1)[0] == item['name'] for key in catalog):
                raise ValueError('DSH plugin version has not been reviewed')
            specs.append(spec)
            continue
        with urllib.request.urlopen(reviewed['tarball'], timeout=20) as response:
            data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('reviewed DSH plugin archive too large')
        reviewed_archive(data, reviewed['integrity'])
        target = Path(home) / f'.approved-plugin-{index}.tgz'
        # The prior worker may have left a link. Never follow it when staging.
        target.unlink(missing_ok=True)
        with target.open('xb') as output:
            output.write(data)
        specs.append(str(target.resolve()))
    return specs

def prepare_plugins(runtime, home, profile, plugins, capabilities, package_manager_cache=None):
    """Use the native CLI; extension code is admitted only to full owner workers.

    Installation never runs package lifecycle scripts or receives model keys.
    The invocation policy patch still disables the unrestricted plugin manager.
    """
    validate_plugins(plugins)
    if not plugins or not all(capabilities.get(key) is True for key in ('web', 'files', 'terminal')):
        return []
    if profile != 'sdk':
        raise ValueError('DSH whitelist plugins require the sdk profile')
    profile_dir = Path(home) / 'profiles' / profile
    # Never reuse executable state that a preceding worker could have changed.
    profiles = Path(home) / 'profiles'
    if profiles.is_symlink():
        profiles.unlink()
    elif profiles.exists():
        shutil.rmtree(profiles)
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR') if key in os.environ}
    env.update({'HOME': str(home), 'DSH_HOME': str(home), 'CI': 'true', 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'COREPACK_DEFAULT_TO_LATEST': '0', 'npm_config_ignore_scripts': 'true'})
    env['npm_config_registry'] = 'https://registry.npmjs.org'
    if package_manager_cache is not None:
        env['COREPACK_HOME'] = str(package_manager_cache)
    specs = plugin_specs(home, plugins)
    command = [str(runtime), 'plugin', '--profile', profile, 'add', '--save-exact', '--ignore-scripts',
               *specs]
    process = subprocess.Popen(command, cwd=str(home), env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if process.wait(timeout=60) != 0:
            raise RuntimeError('DSH whitelist plugin installation failed')
        manifest_path = profile_dir / 'package.json'
        manifest = json.loads(manifest_path.read_text())
        bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']
        for item in plugins:
            package = json.loads((profile_dir / 'node_modules' / item['name'] / 'package.json').read_text())
            if package.get('name') != item['name'] or package.get('version') != item['version'] or not package.get('dsh', {}).get('bundle'):
                raise RuntimeError('DSH whitelist package is not the pinned bundle')
            bundles.append(item['name'])
        manifest.setdefault('dsh', {}).setdefault('profile', {})['bundles'] = bundles
        manifest['dsh']['profile']['patchReload'] = 'startup'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        return [item['name'] for item in plugins]
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        if profiles.exists():
            shutil.rmtree(profiles)
        raise

"""Attachment boundary tests; no provider requests or model calls."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from dsh_imagegen import attachment, package_entry

class ImageAttachmentTests(unittest.TestCase):
    def test_verified_attachment_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            data = b'fixture-image-bytes'
            digest = hashlib.sha256(data).hexdigest()
            path = home / 'attachments/v1/objects' / digest[:2] / digest
            path.parent.mkdir(parents=True)
            path.write_bytes(data)
            result = {'content': [{'type': 'text', 'text': 'Attachment ID: sha256:' + digest}]}
            self.assertEqual(attachment(home, result, 100), data)
            with self.assertRaises(ValueError): attachment(home, result, 1)
            with self.assertRaises(ValueError): attachment(home, {**result, 'is_error': True}, 100)
            with self.assertRaises(ValueError): attachment(home, {'content': []}, 100)
            path.write_bytes(b'changed')
            with self.assertRaises(ValueError): attachment(home, result, 100)
            path.unlink()
            target = home / 'other'
            target.write_bytes(data)
            path.symlink_to(target)
            with self.assertRaises(ValueError): attachment(home, result, 100)

    def test_plugin_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            entry = cache / 'profiles/sdk/node_modules/dsh-image-gen/lib/index.js'
            entry.parent.mkdir(parents=True)
            entry.write_text('modified code')
            with self.assertRaises(ValueError): package_entry(cache)

if __name__ == '__main__': unittest.main()

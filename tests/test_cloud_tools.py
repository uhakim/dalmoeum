import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from tools import build_static, restore_supabase


class CloudToolsTests(unittest.TestCase):
    def test_public_bundle_excludes_private_sources_and_has_cloud_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in build_static.PUBLIC:
                (root / name).write_text('public content', encoding='utf-8')
            (root / 'server.py').write_text('private server', encoding='utf-8')
            (root / '.env').write_text('private secret', encoding='utf-8')
            with patch.object(build_static, 'ROOT', root):
                build_static.build('https://example.supabase.co')
                with zipfile.ZipFile(root / 'dalmoeum-supabase-site.zip') as archive:
                    self.assertNotIn('.env', archive.namelist())
                    self.assertNotIn('server.py', archive.namelist())
                    self.assertIn('https://example.supabase.co', archive.read('cloud-config.js').decode())
                    self.assertIn('frame-ancestors', archive.read('_headers').decode())
                (root / 'dist' / 'student-backup.json').write_text('{}', encoding='utf-8')
                with self.assertRaises(ValueError):
                    build_static.build('https://example.supabase.co')
                for url in ['http://example.com', 'https://example.com/path', 'https://secret@example.com']:
                    with self.assertRaises(ValueError):
                        build_static.build(url)

    def test_restore_rejects_invalid_backups_before_connecting(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'backup.json'
            valid = {'format':'dalmoeum-supabase','version':1,'className':'우리 반','students':[
                {'id':1,'number':1,'name':'달이','state':{'version':1,'profile':{},'records':{},'reflections':{}}}]}
            path.write_text(json.dumps(valid), encoding='utf-8')
            self.assertEqual(restore_supabase.read_backup(path)['students'][0]['name'], '달이')
            valid['students'].append(valid['students'][0])
            path.write_text(json.dumps(valid), encoding='utf-8')
            with self.assertRaises(ValueError):
                restore_supabase.read_backup(path)

    def test_four_class_backup_identity_and_destination_are_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'backup.json'
            backup = {'format':'dalmoeum-supabase','version':2,'classId':2,'className':'2반','students':[
                {'id':41,'number':1,'name':'별이','classroomId':2,'state':{'version':1,'profile':{},'records':{},'reflections':{}}}]}
            path.write_text(json.dumps(backup), encoding='utf-8')
            self.assertEqual(restore_supabase.read_backup(path)['classId'], 2)
            with patch('sys.argv', ['restore_supabase.py', str(path), '--class-id', '1']), patch('builtins.input') as prompt:
                with self.assertRaisesRegex(ValueError, 'destination classroom differ'):
                    restore_supabase.main()
                prompt.assert_not_called()
            backup['students'][0]['id'] = 1
            path.write_text(json.dumps(backup), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'different classroom'):
                restore_supabase.read_backup(path)
            path.write_text('{"format":"unrecognized"}', encoding='utf-8')
            with self.assertRaises(ValueError):
                restore_supabase.read_backup(path)


if __name__ == '__main__':
    unittest.main()

"""Small synthetic release fixtures: no production art, network or publishing."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'tools/release/build-release.py'
spec = importlib.util.spec_from_file_location('build_release', SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.patch = patch.object(release, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.temp.cleanup)
        self.put('web/index.html', '<!doctype html><head><link rel="stylesheet" href="style.css"></head><body><img src="assets/cover/title.webp"><script type="module" src="start.js"></script></body>')
        self.put('web/start.js', "import('./game.js').catch(console.error);\n")
        self.put('web/game.js', "import { compileStory } from './engine-runtime.js';\nfetch('story.json');\n")
        self.put('web/style.css', '@font-face{src:url("assets/fonts/story-serif.woff2")}')
        self.put('web/story.json', json.dumps({'id': 'fixture', 'version': '1', 'start': 'start', 'nodes': [{'id': 'start', 'type': 'end'}], 'assets': {'theme': {'type': 'audio', 'src': 'assets/bgm/theme.ogg'}}}))
        self.put('web/character-portraits.json', json.dumps({'portrait': 'assets/char/normal.webp'}))
        self.put('web/portraits.html', '<a href="index.html">Play</a><img src="assets/char/normal.webp">')
        self.put('web/engine-runtime.js', 'export const compileStory = () => 1;\nexport const createSession = () => null;\n')
        self.put('engine/UPSTREAM.json', json.dumps({'dirty': False, 'commit': 'fixture-commit'}))
        for name in ['LICENSE', 'engine/LICENSE', 'assets/ASSET-SOURCES.json', 'marketing/description.md', 'marketing/release-notes.md', 'marketing/platforms.json', 'tools/release/platform-vibehub.js']:
            self.put(name, '{}')
        self.put('ASSET-LICENSE.md', '[font](web/assets/fonts/story-serif.woff2) [OFL](web/assets/fonts/OFL.txt)')
        for name in ['cover-16x9.jpg', 'cover-4x3.jpg', 'icon.jpg']:
            self.put('marketing/release/' + name, b'marketing')
        for path in ['cover/title.webp', 'char/normal.webp', 'bgm/theme.mp3', 'fonts/story-serif.woff2', 'fonts/OFL.txt', 'fonts/NOTICE.txt', *['sfx/' + p + '.mp3' for p in ['page', 'click', 'choice', 'bell']]]:
            self.put('web/assets/' + path, b'fixture media: ' + path.encode())
        # Big enough to catch accidental global version-based asset renaming.
        self.put('web/assets/cover/title.webp', b'unchanged-art' * 100000)

    def put(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())

    def build(self, version, check_only=False):
        out = self.root.parent / version
        args = [str(SCRIPT), '--out-dir', str(out), '--version', version]
        if check_only:
            args.append('--check-only')
        with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
            release.main()
        return out

    def manifest(self, out, platform='toy'):
        return json.loads((out / platform / 'release-manifest.json').read_text())['files']

    def test_same_content_across_release_versions_has_stable_names(self):
        a, b = self.build('release-a'), self.build('release-b')
        first, second = self.manifest(a), self.manifest(b)
        for logical, entry in first.items():
            if entry['fingerprinted']:
                self.assertEqual(entry, second[logical], logical)
        for platform in ('offline', 'toy', 'vibehub'):
            release.validate_references(a / platform)
            files = self.manifest(a, platform)
            self.assertRegex(files['engine-runtime.js']['path'], r'^engine-runtime\.[0-9a-f]{16}\.js$')
            self.assertFalse(any('dist' in Path(f['path']).parts for f in files.values()))
            self.assertEqual(files['assets/fonts/OFL.txt']['path'], 'assets/fonts/OFL.txt')
            self.assertEqual((a / platform / 'assets/fonts/OFL.txt').read_bytes(), (self.root / 'web/assets/fonts/OFL.txt').read_bytes())
            for logical, entry in files.items():
                data = (a / platform / entry['path']).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
                if entry['fingerprinted']:
                    self.assertIn('.' + entry['sha256'][:16] + '.', entry['path'])
            self.assertEqual(set(f['path'] for f in files.values()) | {'release-manifest.json'}, {p.relative_to(a / platform).as_posix() for p in (a / platform).rglob('*') if p.is_file()})

    def test_code_change_leaves_media_css_and_engine_names_unchanged(self):
        a = self.build('before')
        with (self.root / 'web/game.js').open('a') as output:
            output.write('// one game change\n')
        b = self.build('after')
        first, second = self.manifest(a), self.manifest(b)
        self.assertNotEqual(first['game.js']['path'], second['game.js']['path'])
        self.assertNotEqual(first['start.js']['path'], second['start.js']['path'])
        for logical in ('assets/cover/title.webp', 'assets/bgm/theme.mp3', 'assets/char/normal.webp', 'style.css', 'engine-runtime.js'):
            self.assertEqual(first[logical], second[logical], logical)

    def test_one_image_change_does_not_rename_other_images_or_game(self):
        a = self.build('art-a')
        self.put('web/assets/char/normal.webp', b'changed portrait')
        b = self.build('art-b')
        first, second = self.manifest(a), self.manifest(b)
        self.assertNotEqual(first['assets/char/normal.webp']['path'], second['assets/char/normal.webp']['path'])
        for logical in ('assets/cover/title.webp', 'assets/bgm/theme.mp3', 'game.js', 'start.js', 'style.css'):
            self.assertEqual(first[logical], second[logical], logical)
        page = release.ReleaseHTML()
        page.feed((b / 'offline/portraits.html').read_text())
        self.assertIn(second['assets/char/normal.webp']['path'], page.references)

    def test_engine_change_updates_dependent_code_but_not_media(self):
        a = self.build('engine-a')
        self.put('web/engine-runtime.js', 'export const compileStory = () => 2;\n')
        b = self.build('engine-b')
        first, second = self.manifest(a), self.manifest(b)
        for logical in ('engine-runtime.js', 'game.js', 'start.js'):
            self.assertNotEqual(first[logical]['path'], second[logical]['path'], logical)
        for logical in ('assets/cover/title.webp', 'assets/char/normal.webp', 'style.css'):
            self.assertEqual(first[logical], second[logical], logical)

    def test_map_and_documents_are_present_and_missing_reference_rejected(self):
        out = self.build('valid')
        page = release.ReleaseHTML()
        page.feed((out / 'toy/index.html').read_text())
        files = self.manifest(out)
        for logical in ('story.json', 'character-portraits.json', 'assets/sfx/page.mp3', 'assets/bgm/theme.mp3'):
            self.assertEqual(page.assets[logical], files[logical]['path'])
        story_file = out / 'toy' / files['story.json']['path']
        original = story_file.read_bytes()
        story = json.loads(original)
        story['assets']['missing'] = {'type': 'image', 'src': 'assets/not-mapped.webp'}
        story_file.write_text(json.dumps(story))
        with self.assertRaisesRegex(ValueError, 'Missing logical release asset mapping'):
            release.validate_references(out / 'toy')
        story_file.write_bytes(original)
        (out / 'toy' / files['assets/sfx/page.mp3']['path']).unlink()
        with self.assertRaisesRegex(ValueError, 'Missing/nonlocal release reference'):
            release.validate_references(out / 'toy')

    def test_check_only_writes_nothing_and_changed_startup_contract_fails(self):
        out = self.build('check-only', check_only=True)
        self.assertFalse(out.exists())
        self.put('web/start.js', "import('./renamed-game.js');")
        with self.assertRaisesRegex(ValueError, 'Expected one game.js'):
            self.build('invalid')

    def test_html_urls_preserve_queries_and_inline_json_is_script_safe(self):
        value = release.rewrite_html('<img src="./assets/a.webp?x=1&amp;y=2#v">', {'assets/a.webp': 'assets/a.123.webp'})
        self.assertEqual(value, '<img src="assets/a.123.webp?x=1&amp;y=2#v">')
        unusual = 'assets/char/</script>.webp'
        self.put('web/' + unusual, b'valid bytes')
        self.put('web/character-portraits.json', json.dumps({'portrait': unusual}))
        self.put('web/portraits.html', '<a href="index.html">Play</a>')
        out = self.build('escaping')
        text = (out / 'toy/index.html').read_text()
        self.assertNotIn('</script>.webp', text)
        self.assertIn('\\u003c/script>.webp', text)
        page = release.ReleaseHTML()
        page.feed(text)
        self.assertEqual(page.assets[unusual], self.manifest(out)[unusual]['path'])



if __name__ == '__main__':
    unittest.main()

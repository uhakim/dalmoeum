"""Build a public-only static bundle; no server source, backups or secrets."""
import argparse
import json
from pathlib import Path
import shutil
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ['index.html', 'teacher.html', 'reports.html', 'style.css', 'classroom.css',
          'app.js', 'classroom.js', 'teacher.js', 'reports.js', 'moon.js', 'cloud.js']


def build(url):
    url = url.rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Use the HTTPS Supabase project URL without a path or key.')
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    # Refuse an unexpected existing file instead of accidentally publishing it.
    allowed = set(PUBLIC + ['cloud-config.js', '_headers'])
    unexpected = [p.name for p in output.iterdir() if p.name not in allowed or not p.is_file()]
    if unexpected:
        raise ValueError('Unexpected files in dist; inspect before publishing: ' + ', '.join(unexpected))
    for name in PUBLIC:
        shutil.copyfile(ROOT / name, output / name)
    (output / 'cloud-config.js').write_text('window.DAL_CONFIG = ' + json.dumps({'supabaseUrl': url}) + ';\n', encoding='utf-8')
    (output / '_headers').write_text(
        '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n'
        '  Cache-Control: no-cache\n'
        "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; "
        f"connect-src 'self' {url}; img-src 'self' data: blob:; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'none'; form-action 'self'\n", encoding='utf-8')
    archive = ROOT / 'dalmoeum-supabase-site.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for name in sorted(allowed):
            target.write(output / name, name)
    print(f'Public site: {output}\nUpload archive: {archive}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--supabase-url', required=True)
    build(parser.parse_args().supabase_url)


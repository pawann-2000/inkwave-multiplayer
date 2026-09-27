# Assemble dist/ for release: the game bundled and minified by esbuild (content-hashed, code-split ES modules — lazy
# parts such as online play stay separate chunks), one minified stylesheet, the assets, index.html pointing at the
# bundle, the licences of bundled third-party code, and the static host's response headers.
# Development needs none of this: index.html + the import map run the sources as they are.
import base64, hashlib, json, os, re, shutil, subprocess, tempfile

ESBUILD = ['npx', '--yes', 'esbuild@0.28.2']   # pinned; runs from the npm cache, not a project dependency
keep = {'.vercel', 'vercel.json'}
if os.path.isdir('dist'):
    for n in os.listdir('dist'):
        if n in keep: continue
        p = os.path.join('dist', n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
else:
    os.makedirs('dist')

# JS: the import map's bare specifiers resolved here (longest alias wins: three/addons → the addon tree)
meta_path = os.path.join(tempfile.mkdtemp(), 'meta.json')
subprocess.run(ESBUILD + [
    'src/main.js', '--bundle', '--splitting', '--format=esm', '--minify', '--target=es2022',
    '--outdir=dist/js', '--entry-names=[name]-[hash]', '--chunk-names=c-[hash]', '--legal-comments=eof',
    f'--metafile={meta_path}', '--log-level=warning',
    '--alias:three=./vendor/three/build/three.module.js', '--alias:three/addons=./vendor/three/jsm',
    '--alias:@trystero-p2p/core=./vendor/trystero/core/index.mjs', '--alias:@noble/secp256k1=./vendor/noble-secp256k1/index.js',
], check=True)
# CSS: ui.css with its @imports inlined; fonts stay in assets/ (same relative path from dist/styles/)
subprocess.run(ESBUILD + ['styles/ui.css', '--bundle', '--minify', '--external:*.woff2', '--outfile=dist/styles/ui.css', '--log-level=warning'], check=True)
shutil.copytree('assets', 'dist/assets')
shutil.copy('manifest.webmanifest', 'dist/manifest.webmanifest')   # install / Add to Home Screen: fullscreen, landscape
os.makedirs('dist/licenses')   # three.js keeps its @license header inside the bundle
shutil.copy('vendor/trystero/LICENSE', 'dist/licenses/trystero.txt')
shutil.copy('vendor/noble-secp256k1/LICENSE', 'dist/licenses/noble-secp256k1.txt')

# index.html → the bundle: no import map; the entry chunk's static imports preloaded so they load in parallel
meta = json.load(open(meta_path))
entry = next(k for k, v in meta['outputs'].items() if v.get('entryPoint') == 'src/main.js')
static = [i['path'] for i in meta['outputs'][entry]['imports'] if i['kind'] == 'import-statement']
rel = lambda p: './' + os.path.relpath(p, 'dist')
html = open('index.html', encoding='utf-8').read().replace('\r\n', '\n')
html = re.sub(r'<script type="importmap">.*?</script>\n', '', html, flags=re.S)
html = html.replace('<script type="module" src="./src/main.js"></script>',
                    ''.join(f'<link rel="modulepreload" href="{rel(p)}">\n' for p in static) + f'<script type="module" src="{rel(entry)}"></script>')
assert 'importmap' not in html and './src/main.js' not in html, 'index.html layout changed: update tools/build-dist.py'
open('dist/index.html', 'w', encoding='utf-8').write(html)

# Response headers for the static host (Cloudflare Workers static assets read dist/_headers; the file is not served).
# CSP: scripts only from this origin plus index.html's inline script(s) pinned by hash, so injected markup can't run
# code. Styles need 'unsafe-inline' (style attributes inside the UI's SVG markup); the two Workers (hidden-tab tick,
# music clock) start from blob: URLs; online play reaches Nostr relays over wss: (the list lives in Trystero and
# NET.relays, so any wss: host); WebRTC data channels are outside CSP.
inline = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
hashes = ' '.join("'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode() for s in inline)
csp = '; '.join([
    "default-src 'self'", f"script-src 'self' {hashes}", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self'", "connect-src 'self' wss:", "worker-src 'self' blob:", "media-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
])
headers = [
    ('Content-Security-Policy', csp),
    ('X-Content-Type-Options', 'nosniff'),
    ('Referrer-Policy', 'no-referrer'),
    ('Cross-Origin-Opener-Policy', 'same-origin'),
    ('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'),
]
with open('dist/_headers', 'w', encoding='utf-8') as f:
    f.write('/*\n' + ''.join(f'  {k}: {v}\n' for k, v in headers))
    # content-hashed bundle files never change under the same name: cache them for good (no revalidation round trips)
    f.write('/js/*\n  Cache-Control: public, max-age=31536000, immutable\n')
# never upload the Vercel link files kept above
with open('dist/.assetsignore', 'w', encoding='utf-8') as f:
    f.write('.vercel\nvercel.json\n')
js = [p for p in meta['outputs'] if p.endswith('.js')]
print(f'dist ready: {len(js)} JS chunks ({sum(meta["outputs"][p]["bytes"] for p in js) / 1e3:.0f} KB minified), '
      f'{len(static)} preloaded, {len(inline)} inline script(s) pinned in the CSP')

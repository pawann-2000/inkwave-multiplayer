# Assemble dist/: the game files plus only the three.js addons the game imports (and their deps).
import re, os, shutil, glob
root = 'vendor/three/jsm'
keep = {'.vercel', 'vercel.json'}
if os.path.isdir('dist'):
    for n in os.listdir('dist'):
        if n in keep: continue
        p = os.path.join('dist', n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
else:
    os.makedirs('dist')
need = set()
for f in glob.glob('src/**/*.js', recursive=True):
    need |= {m for m in re.findall(r"three/addons/([A-Za-z0-9_./-]+\.js)", open(f).read())}
need, seen = list(need), set()
while need:
    f = need.pop()
    if f in seen: continue
    seen.add(f)
    for m in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", open(os.path.join(root, f)).read()):
        need.append(os.path.normpath(os.path.join(os.path.dirname(f), m)))
for f in seen:
    d = os.path.join('dist/vendor/three/jsm', f); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy(os.path.join(root, f), d)
os.makedirs('dist/vendor/three/build', exist_ok=True)
for f in ['three.module.js', 'three.core.js']: shutil.copy('vendor/three/build/' + f, 'dist/vendor/three/build/' + f)
for d in ['src', 'styles', 'assets']: shutil.copytree(d, 'dist/' + d)
# online play: P2P signaling (Trystero over Nostr) — loaded on demand when a player opens the online lobby
for d in ['vendor/trystero', 'vendor/noble-secp256k1']: shutil.copytree(d, 'dist/' + d, ignore=shutil.ignore_patterns('*.map'))
shutil.copy('index.html', 'dist/index.html')

# Response headers for the static host (Cloudflare Workers static assets read dist/_headers; the file is not served).
# CSP: scripts only from this origin plus index.html's inline scripts (the import map, the fade-in) pinned by hash, so
# injected markup can't run code. Styles need 'unsafe-inline' (style attributes inside the UI's SVG markup); the two
# Workers (hidden-tab tick, music clock) start from blob: URLs; online play reaches Nostr relays over wss: (the list
# lives in Trystero and NET.relays, so any wss: host); WebRTC data channels are outside CSP.
import base64, hashlib
html = open('dist/index.html', encoding='utf-8').read().replace('\r\n', '\n')
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
# never upload the Vercel link files kept above
with open('dist/.assetsignore', 'w', encoding='utf-8') as f:
    f.write('.vercel\nvercel.json\n')
print('dist ready:', len(seen), 'addon files ·', len(inline), 'inline scripts pinned in the CSP')

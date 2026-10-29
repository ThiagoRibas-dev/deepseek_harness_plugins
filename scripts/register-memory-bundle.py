#!/usr/bin/env python3
"""
Register the dsh-memory bundle in the active web profile.

Idempotent: running it twice changes nothing. Writes three things:

  1. `package.json`  — the `link:` dependency and the `dsh.profile.bundles` entry
  2. `node_modules/@local/dsh-memory` — the symlink that entry resolves through
                       (what `pnpm install` would create for a `link:` dep)
  3. `cordis.patch.yml` — an override row carrying the API token, and the plugin
                       directory on the HMR watch list

The token is generated, not invented: the route refuses to serve without one, and
a token written by hand into a file is a token chosen badly.
"""
import json
import os
import re
import secrets
import shutil
import sys

PROFILE = '/root/.dsh/profiles/web'
PLUGIN = '/export/DownloadsSSD/SHARED/harnesses/dsh/plugins/dsh-memory'
NAME = '@local/dsh-memory'
LINK = f'link:{PLUGIN}'

changed = []


def backup(path):
    target = f'{path}.pre-memory'
    if not os.path.exists(target):
        shutil.copy2(path, target)
        print(f'  backed up {path} -> {target}')


# ---------------------------------------------------------------- package.json
pkg_path = os.path.join(PROFILE, 'package.json')
backup(pkg_path)
with open(pkg_path) as f:
    pkg = json.load(f)

if NAME not in pkg['dependencies']:
    # Keep the block alphabetical, as it already is.
    deps = pkg['dependencies']
    deps[NAME] = LINK
    pkg['dependencies'] = dict(sorted(deps.items()))
    changed.append('dependencies')

bundles = pkg['dsh']['profile']['bundles']
if NAME not in bundles:
    bundles.append(NAME)
    changed.append('bundles')

with open(pkg_path, 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
print('package.json:', ', '.join(changed) or 'already registered')

# ---------------------------------------------------------------- symlink
link_path = os.path.join(PROFILE, 'node_modules', '@local', 'dsh-memory')
os.makedirs(os.path.dirname(link_path), exist_ok=True)
if os.path.islink(link_path):
    print('symlink: already present')
elif os.path.exists(link_path):
    print(f'symlink: {link_path} exists and is not a symlink; leaving it alone')
else:
    # Same relative shape pnpm produces for a link: dependency.
    os.symlink(PLUGIN, link_path)
    print('symlink: created')

# ---------------------------------------------------------------- cordis patch
patch_path = os.path.join(PROFILE, 'cordis.patch.yml')
backup(patch_path)
with open(patch_path) as f:
    patch = f.read()

token_match = re.search(r"^- id: tts\n(?:.*\n)*?    apiToken: '([^']+)'", patch, re.M)
token = token_match.group(1) if token_match else None
# A distinct token per route: one credential guarding two different surfaces
# means revoking either revokes both.
memory_token = secrets.token_urlsafe(32)

if '  # --- dsh-memory (added by the memory bundle)' not in patch:
    addition = f"""
# --- dsh-memory (added by the memory bundle) ---------------------------------
# The bundle's own patch enables the API with an empty token, which makes the
# route answer 503 rather than serving memory to anyone who can reach the port.
# The token belongs here, in deployment state, exactly as the TTS row does it.
- id: memory
  config:
    apiEnabled: true
    apiToken: '{memory_token}'
    captureTranscripts: true
"""
    patch = patch.rstrip('\n') + '\n' + addition
    changed.append('memory override row')

# Watch the bundle so editing it reloads instead of needing a restart.
hmr_marker = f'      - {PLUGIN}\n'
if hmr_marker not in patch:
    patch = re.sub(
        r'(- id: hmr\n  config:\n    root:\n)',
        r'\1' + hmr_marker,
        patch,
        count=1,
    )
    changed.append('hmr watch entry')

with open(patch_path, 'w') as f:
    f.write(patch)
print('cordis.patch.yml:', ', '.join(c for c in changed if c in ('memory override row', 'hmr watch entry')) or 'already present')
print()
print('token for the memory API:', memory_token)
print('(the settings panel receives it through the injected page identity)')

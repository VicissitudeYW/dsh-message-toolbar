
// Copy the built plugin into a DSH profile's node_modules so a plain restart
// picks it up. A `file:` install creates a real directory copy, so rebuilding
// in this repo is not enough on its own.
//
//   node scripts/sync-profile.mjs          # ~/.dsh/profiles/web
//   node scripts/sync-profile.mjs desktop  # ~/.dsh/profiles/desktop

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const profile = process.argv[2] ?? 'web';
const target = path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-message-toolbar');

if (!fs.existsSync(path.dirname(target))) {
  console.error('profile not found: ' + path.dirname(target));
  process.exit(1);
}

fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(target, 'docs'), { recursive: true });

for (const file of ['package.json', 'cordis.patch.yml', 'plugin.client.js', 'README.md', 'LICENSE']) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
}
for (const file of fs.readdirSync(path.join(root, 'lib'))) {
  fs.copyFileSync(path.join(root, 'lib', file), path.join(target, 'lib', file));
}
for (const file of fs.readdirSync(path.join(root, 'docs'))) {
  fs.copyFileSync(path.join(root, 'docs', file), path.join(target, 'docs', file));
}
for (const file of fs.readdirSync(path.join(root, 'scripts'))) {
  fs.copyFileSync(path.join(root, 'scripts', file), path.join(target, 'scripts', file));
}

console.log('synced dsh-message-toolbar -> ' + target);

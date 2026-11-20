import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('a clean checkout can sync all runtime modules without an ignored changelog', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-sync-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'checkout');
  const home = path.join(temporary, 'home');
  for (const dir of ['scripts', 'lib', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/sync-profile.mjs', import.meta.url), path.join(root, 'scripts', 'sync-profile.mjs'));
  for (const name of ['package.json', 'cordis.patch.yml', 'plugin.client.js', 'README.md', 'README.en.md', 'LICENSE']) {
    fs.writeFileSync(path.join(root, name), name);
  }
  fs.writeFileSync(path.join(root, 'lib', 'durable-state.js'), 'runtime module');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-profile.mjs'), 'desktop'], {
    encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const installed = path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-message-toolbar');
  assert.equal(fs.readFileSync(path.join(installed, 'lib', 'durable-state.js'), 'utf8'), 'runtime module');
  assert.equal(fs.existsSync(path.join(installed, 'CHANGELOG.md')), false);
});

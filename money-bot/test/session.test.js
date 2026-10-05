import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';

test('two sessions persist cookies and rotated auth only to their own paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-money-sessions-'));
  const first = { envFile: join(dir, 'first.env'), sessionFile: join(dir, 'first.session.json') };
  const second = { envFile: join(dir, 'second.env'), sessionFile: join(dir, 'second.session.json') };
  const a = new Session(first), b = new Session(second);
  const cookie = (id) => `sb-cyrxjeppjqsxxjayfrur-auth-token=base64-${Buffer.from(JSON.stringify({ user: { id } })).toString('base64url')}`;
  try {
    a.replaceCookie(cookie('first-id'));
    b.replaceCookie(cookie('second-id'));
    assert.equal(a.userId(), 'first-id');
    assert.equal(b.userId(), 'second-id');
    assert.ok(readFileSync(first.envFile, 'utf8').includes(cookie('first-id')));
    assert.ok(readFileSync(second.envFile, 'utf8').includes(cookie('second-id')));
    a.writeAuth({ user: { id: 'first-rotated' }, access_token: 'a' });
    assert.equal(a.userId(), 'first-rotated');
    assert.equal(b.userId(), 'second-id');
    assert.equal(existsSync(first.sessionFile), true);
    assert.equal(existsSync(second.sessionFile), false);
    b.writeAuth({ user: { id: 'second-rotated' }, access_token: 'b' });
    assert.equal(new Session(first).userId(), 'first-rotated');
    assert.equal(new Session(second).userId(), 'second-rotated');
  } finally {
    for (const file of [first.envFile, first.sessionFile, second.envFile, second.sessionFile])
      if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  }
});

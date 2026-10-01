import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { envValue, readEnvFile } from './env.js';

/**
 * `envValue` is the single-key form of `readEnvFile` — same file, same parser,
 * same rules. These pin that equivalence, because the reason it exists is that
 * a second hand-rolled parser drifted from this one on quoted values.
 */
describe('envValue', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (content: string): void => fs.writeFileSync(path.join(root, '.env'), content);

  it('strips surrounding quotes, exactly as readEnvFile does', () => {
    write('TZ="America/New_York"\nPLAIN=bare\nSINGLE=\'quoted\'\n');
    expect(envValue('TZ', root)).toBe('America/New_York');
    expect(envValue('PLAIN', root)).toBe('bare');
    expect(envValue('SINGLE', root)).toBe('quoted');
    for (const key of ['TZ', 'PLAIN', 'SINGLE']) {
      expect(envValue(key, root)).toBe(readEnvFile([key], root)[key]);
    }
  });

  it('preserves a quoted value that contains spaces', () => {
    write('TEMPLATE_PATH="/opt/my templates"\n');
    expect(envValue('TEMPLATE_PATH', root)).toBe('/opt/my templates');
  });

  it('returns undefined for a missing key, an empty value, and a missing file', () => {
    write('SET=value\nEMPTY=\n# COMMENT=no\n');
    expect(envValue('ABSENT', root)).toBeUndefined();
    expect(envValue('EMPTY', root)).toBeUndefined();
    expect(envValue('COMMENT', root)).toBeUndefined();
    expect(envValue('SET', path.join(root, 'nowhere'))).toBeUndefined();
  });

  it('keeps = inside the value', () => {
    write('TOKEN=abc=def==\n');
    expect(envValue('TOKEN', root)).toBe('abc=def==');
  });
});

/**
 * A `keychain://<service>/<account>` value is resolved against the macOS login
 * Keychain so a secret never sits in .env as plaintext. These pin the safe
 * degradations: a value that is not a reference is untouched, and any reference
 * that cannot be read (missing item here, and no `security` at all on Linux CI)
 * is dropped — exactly like an absent secret — never surfaced literally.
 */
describe('keychain secret references', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (content: string): void => fs.writeFileSync(path.join(root, '.env'), content);

  it('returns a non-reference value unchanged', () => {
    write('TELEGRAM_BOT_TOKEN=123456:AAbc-def\n');
    expect(envValue('TELEGRAM_BOT_TOKEN', root)).toBe('123456:AAbc-def');
  });

  it('drops a reference that cannot be resolved, like an absent secret', () => {
    write('TELEGRAM_BOT_TOKEN=keychain://nanoclaw-absent-service/NANOCLAW_ABSENT_ACCOUNT\n');
    expect(envValue('TELEGRAM_BOT_TOKEN', root)).toBeUndefined();
  });

  it('drops a malformed reference with no account part', () => {
    write('TELEGRAM_BOT_TOKEN=keychain://service-only\n');
    expect(envValue('TELEGRAM_BOT_TOKEN', root)).toBeUndefined();
  });
});

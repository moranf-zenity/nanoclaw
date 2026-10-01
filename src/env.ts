import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

// A secret can be stored outside .env as a `keychain://<service>/<account>`
// reference to the macOS login Keychain, so the token never sits in .env as
// plaintext. It is resolved here and handed back like any other value — still
// never written to process.env, so it does not leak to child containers.
// `/usr/bin/security` is pinned (no PATH lookup) and the item's ACL is expected
// to trust it, so the read is non-interactive on an unlocked login Keychain.
// A failed read (locked keychain, missing item, non-macOS host) returns
// undefined, so the caller degrades exactly as for an absent secret rather than
// the service crashing or hanging on a startup prompt.
const KEYCHAIN_REF_PREFIX = 'keychain://';

function resolveSecretRef(value: string): string | undefined {
  if (!value.startsWith(KEYCHAIN_REF_PREFIX)) return value;
  const ref = value.slice(KEYCHAIN_REF_PREFIX.length);
  const slash = ref.indexOf('/');
  const service = slash === -1 ? '' : ref.slice(0, slash);
  const account = slash === -1 ? '' : ref.slice(slash + 1);
  if (!service || !account) {
    log.warn('Malformed keychain reference; expected keychain://<service>/<account>', { value });
    return undefined;
  }
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const secret = out.replace(/\n$/, '');
    return secret || undefined;
  } catch (err) {
    log.warn('Could not resolve keychain reference from the login Keychain', { service, account, err });
    return undefined;
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * `projectRoot` defaults to the current working directory; pass it when
 * reading a .env that is not the running process's own.
 */
export function readEnvFile(keys: string[], projectRoot?: string): Record<string, string> {
  const envFile = path.join(projectRoot ?? process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      const resolved = resolveSecretRef(value);
      if (resolved) result[key] = resolved;
    }
  }

  return result;
}

/**
 * Read one key from the .env file. Same parser, same rules as `readEnvFile` —
 * this is the single-key form of it, so a caller wanting one value does not
 * hand-roll `readEnvFile([KEY])[KEY]` and does not grow a second parser.
 *
 * Returns undefined when the file, the key, or the value is absent.
 */
export function envValue(key: string, projectRoot?: string): string | undefined {
  return readEnvFile([key], projectRoot)[key];
}

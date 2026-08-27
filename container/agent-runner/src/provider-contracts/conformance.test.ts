import { describe, expect, it } from 'bun:test';

import '../providers/index.js';
import { createProvider } from '../providers/factory.js';
import { listProviderNames } from '../providers/provider-registry.js';
import './index.js';
import {
  RUNTIME_SEAM_VERSION,
  getProviderRuntimeContract,
  hasDeclaredProviderRuntimeContract,
  resolveProviderSeamVersion,
} from './registry.js';
import { assertProviderRuntimeContractShape, probeProviderRuntimeConfiguration } from './verifier.js';

/**
 * Registration is a map write, so this suite is where a declared-but-dead
 * capability is caught. It runs on every container test run and inside the
 * install-time verifier — the two moments a payload actually enters a tree —
 * instead of at container startup, where a throw would kill a `--rm`
 * container and take its logs with it.
 */
describe('installed runtime provider contracts', () => {
  const declared = listProviderNames().filter(hasDeclaredProviderRuntimeContract);

  it('match their provider implementations', () => {
    for (const provider of declared) {
      expect(() => createProvider(provider)).not.toThrow();
    }
  });

  it('satisfy the contract shape', () => {
    for (const provider of declared) {
      const contract = getProviderRuntimeContract(provider)!;
      expect(() => assertProviderRuntimeContractShape(provider, contract)).not.toThrow();
    }
  });

  it('have live configuration capabilities', () => {
    for (const provider of declared) {
      const contract = getProviderRuntimeContract(provider)!;
      expect(() => probeProviderRuntimeConfiguration(provider, contract)).not.toThrow();
    }
  });

  it('target a seam version core implements', () => {
    for (const provider of declared) {
      const contract = getProviderRuntimeContract(provider)!;
      expect(resolveProviderSeamVersion(contract)).toBeLessThanOrEqual(RUNTIME_SEAM_VERSION);
    }
  });
});

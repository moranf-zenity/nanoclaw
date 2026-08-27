import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';
import '../provider-contracts/index.js';
import { getProviderRuntimeContract } from '../provider-contracts/registry.js';
import {
  archiveProviderExchangeFromContract,
  bindProviderRuntimeInputs,
  maybeRotateProviderContinuation,
  realizeProviderManagedFiles,
} from '../provider-contracts/realize.js';
import type { RuntimeConfigurationInputs } from '../provider-contracts/registry.js';

export function createProvider(name: string, options: ProviderOptions = {}): AgentProvider {
  const contract = getProviderRuntimeContract(name);
  // The core-owned inputs for this instance: one object, owned here, closed
  // over by the render path below.
  const inputs: Partial<RuntimeConfigurationInputs> = {
    inference: { model: options.model, effort: options.effort, fastMode: options.fastMode },
    mcpServers: options.mcpServers ?? {},
  };
  const provider = getProviderFactory(name)(
    contract
      ? {
          ...options,
          coreIo: {
            realizeManagedFiles: (when, context) => realizeProviderManagedFiles(name, when, context, inputs),
          },
        }
      : options,
  );
  if (contract) {
    bindProviderRuntimeInputs(provider, inputs);

    if (contract.archives?.trigger === 'exchange-complete') {
      provider.onExchangeComplete = (exchange) => {
        archiveProviderExchangeFromContract(name, exchange);
      };
    }

    if (contract.continuationRotation) {
      provider.maybeRotateContinuation = (continuation) =>
        maybeRotateProviderContinuation(name, continuation, options.assistantName, (message) =>
          console.error(`[${name}-provider] ${message}`),
        );
    }
  }
  return provider;
}

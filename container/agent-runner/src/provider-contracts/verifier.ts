import path from 'path';

import type {
  ProviderRuntimeContract,
  RuntimeConfigurationCapabilityName,
  RuntimeConfigurationInputs,
  RuntimeManagedFile,
} from './registry.js';

const INPUT_CAPABILITY_NAMES = ['inference', 'memory', 'mcpServers'] as const;
type InputCapabilityName = (typeof INPUT_CAPABILITY_NAMES)[number];

/** Default probe fixtures for the input-sensitivity checks. */
const DEFAULT_PROBES: {
  [K in Exclude<RuntimeConfigurationCapabilityName, 'executionPolicy'>]: {
    a: RuntimeConfigurationInputs[K];
    b: RuntimeConfigurationInputs[K];
  };
} = {
  inference: { a: { model: 'nanoclaw-probe-model-a' }, b: { model: 'nanoclaw-probe-model-b' } },
  memory: {
    a: { command: 'nanoclaw-probe-hook-a', legacyCommands: [], sources: ['startup'] },
    b: { command: 'nanoclaw-probe-hook-b', legacyCommands: [], sources: ['startup'] },
  },
  mcpServers: {
    a: {},
    b: { 'nanoclaw-probe-server': { command: 'nanoclaw-probe-command' } },
  },
};

/** Shape check for one contract. Run by tests and install-time verification, not startup. */
export function assertProviderRuntimeContractShape(name: string, contract: ProviderRuntimeContract): void {
  validateContract(providerKey(name), contract);
}

/** Behavioral probes for one contract. Run by tests and install-time verification, not startup. */
export function probeProviderRuntimeConfiguration(name: string, contract: ProviderRuntimeContract): void {
  probeConfiguration(providerKey(name), contract);
}

function validateContract(provider: string, contract: ProviderRuntimeContract): void {
  if (!Array.isArray(contract.managedFiles)) throw new Error(`${provider}.managedFiles must be an array`);
  unique(
    contract.managedFiles.map((file) => file.id),
    `${provider}.managedFiles[].id`,
  );
  unique(
    contract.managedFiles.map((file) => file.relativePath),
    `${provider}.managedFiles[] paths`,
  );
  for (const file of contract.managedFiles) {
    contractName(file.id, `${provider}.managedFiles[].id`);
    requireFunction(file.root, `${provider}.managedFiles.${file.id}.root`);
    requireFunction(file.transform, `${provider}.managedFiles.${file.id}.transform`);
    assertRelativePath(file.relativePath, `${provider}.managedFiles.${file.id}.relativePath`);
    assertAllowed(
      file.when,
      ['memory-session-hook-registration', 'before-query'],
      `${provider}.managedFiles.${file.id}.when`,
    );
    assertAllowed(file.read, ['none', 'text-if-present'], `${provider}.managedFiles.${file.id}.read`);
  }

  if (contract.configuration === null || typeof contract.configuration !== 'object') {
    throw new Error(`${provider}.configuration is required`);
  }
  const policy = contract.configuration.executionPolicy;
  const policyField = `${provider}.configuration.executionPolicy`;
  if (policy === null || typeof policy !== 'object') throw new Error(`${policyField} is required`);
  const policySections = policy.sections ?? [];
  if (!Array.isArray(policySections)) throw new Error(`${policyField}.sections must be an array`);
  const policySurfaces = [
    policy.value !== undefined,
    policy.resolve !== undefined,
    policySections.length > 0,
  ].filter(Boolean).length;
  if (policySurfaces === 0) {
    throw new Error(`${policyField} must state a stance (value, resolve, or sections)`);
  }
  if (policySurfaces > 1) {
    throw new Error(`${policyField} must state exactly one of value, resolve, or sections`);
  }
  if (policy.resolve !== undefined) requireFunction(policy.resolve, `${policyField}.resolve`);
  for (const section of policySections) {
    requireFunction(section.render, `${policyField}.sections.${section.managedFile}.render`);
    if (!contract.managedFiles.some((file) => file.id === section.managedFile)) {
      throw new Error(`${policyField} references missing managed file '${section.managedFile}'`);
    }
  }

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    if (implementation === null || typeof implementation !== 'object') {
      throw new Error(`${field} is required`);
    }
    const sections = implementation.sections ?? [];
    if (!Array.isArray(sections)) throw new Error(`${field}.sections must be an array`);
    if (sections.length === 0 && implementation.resolve === undefined) {
      throw new Error(`${field} must implement at least one surface (sections or resolve)`);
    }
    if (implementation.resolve !== undefined) requireFunction(implementation.resolve, `${field}.resolve`);
    unique(
      sections.map((section) => section.managedFile),
      `${field}.sections[].managedFile`,
    );
    for (const section of sections) {
      requireFunction(section.render, `${field}.sections.${section.managedFile}.render`);
      if (!contract.managedFiles.some((file) => file.id === section.managedFile)) {
        throw new Error(`${field} references missing managed file '${section.managedFile}'`);
      }
    }
  }

  if (contract.archives !== undefined) {
    assertAllowed(contract.archives.trigger, ['pre-compact', 'exchange-complete'], `${provider}.archives.trigger`);
    requireFunction(contract.archives.plan, `${provider}.archives.plan`);
    if (contract.archives.trigger === 'pre-compact' && contract.compaction !== 'provider-hook') {
      throw new Error(`${provider}.archives pre-compact trigger requires compaction 'provider-hook'`);
    }
  }

  if (contract.continuationRotation !== undefined) {
    const rotation = contract.continuationRotation;
    requireFunction(rotation.plan, `${provider}.continuationRotation.plan`);
    requireFunction(rotation.root, `${provider}.continuationRotation.root`);
    assertRelativePath(rotation.searchSubdirectory, `${provider}.continuationRotation.searchSubdirectory`);
    if (!rotation.extension?.startsWith('.') || rotation.extension.includes('/') || rotation.extension.includes('\\')) {
      throw new Error(`${provider}.continuationRotation.extension must be a file extension`);
    }
  }

  if (!Array.isArray(contract.traceReaders)) throw new Error(`${provider}.traceReaders must be an array`);
  unique(
    contract.traceReaders.map((trace) => trace.id),
    `${provider}.traceReaders[].id`,
  );
  for (const trace of contract.traceReaders) {
    contractName(trace.id, `${provider}.traceReaders[].id`);
    requireFunction(trace.read, `${provider}.traceReaders.${trace.id}.read`);
  }

  assertAllowed(contract.textDelivery, ['mid-turn-complete', 'result'], `${provider}.textDelivery`);
  if (contract.compaction !== undefined) {
    assertAllowed(contract.compaction, ['provider-hook', 'provider-native'], `${provider}.compaction`);
  }
  assertAllowed(contract.commands?.formatting, ['native', 'xml'], `${provider}.commands.formatting`);
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands.nativeAdmin, `${provider}.commands.nativeAdmin`);
  unique(contract.commands.nativeFiltered, `${provider}.commands.nativeFiltered`);
}

function probeConfiguration(provider: string, contract: ProviderRuntimeContract): void {
  const probeInputs = (
    capability: InputCapabilityName,
    variant: 'a' | 'b',
  ): RuntimeConfigurationInputs[InputCapabilityName] => {
    const declared = contract.configuration[capability].probes as
      | { a: RuntimeConfigurationInputs[typeof capability]; b: RuntimeConfigurationInputs[typeof capability] }
      | undefined;
    return (declared ?? DEFAULT_PROBES[capability])[variant];
  };

  const renderFileContent = (
    file: RuntimeManagedFile,
    overrides: Partial<Record<RuntimeConfigurationCapabilityName, { render: boolean; variant: 'a' | 'b' }>>,
  ): { threw: boolean; content: string | null } => {
    const sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>> = {};
    const policySection = (contract.configuration.executionPolicy.sections ?? []).find(
      (candidate) => candidate.managedFile === file.id,
    );
    if (policySection && (overrides.executionPolicy ?? { render: true }).render) {
      sections.executionPolicy = policySection.render();
    }
    for (const capability of INPUT_CAPABILITY_NAMES) {
      const section = (contract.configuration[capability].sections ?? []).find(
        (candidate) => candidate.managedFile === file.id,
      );
      if (!section) continue;
      const override = overrides[capability] ?? { render: true, variant: 'a' as const };
      if (!override.render) continue;
      sections[capability] = (section.render as (input: unknown) => unknown)(
        probeInputs(capability, override.variant),
      );
    }
    try {
      const result = file.transform({
        exists: false,
        content: '',
        filePath: `nanoclaw-probe:${file.relativePath}`,
        context: undefined,
        sections,
      });
      return { threw: false, content: result.kind === 'replace' ? result.content : null };
    } catch {
      return { threw: true, content: null };
    }
  };

  const boundFiles = new Map<string, RuntimeManagedFile>();
  for (const section of contract.configuration.executionPolicy.sections ?? []) {
    const file = contract.managedFiles.find((candidate) => candidate.id === section.managedFile)!;
    boundFiles.set(file.id, file);
  }
  for (const capability of INPUT_CAPABILITY_NAMES) {
    for (const section of contract.configuration[capability].sections ?? []) {
      const file = contract.managedFiles.find((candidate) => candidate.id === section.managedFile)!;
      boundFiles.set(file.id, file);
    }
  }

  const baselines = new Map<string, string>();
  for (const [id, file] of boundFiles) {
    const baseline = renderFileContent(file, {});
    if (baseline.threw || baseline.content === null) {
      throw new Error(
        `${provider}.managedFiles.${id} transform must produce content from an empty state during probes`,
      );
    }
    baselines.set(id, baseline.content);
  }

  const probeEnvironment = (capability: InputCapabilityName): NodeJS.ProcessEnv =>
    contract.configuration[capability].probes?.environment ?? {};

  const policy = contract.configuration.executionPolicy;
  const policyField = `${provider}.configuration.executionPolicy`;
  for (const section of policy.sections ?? []) {
    const file = boundFiles.get(section.managedFile)!;
    const removed = renderFileContent(file, { executionPolicy: { render: false, variant: 'a' } });
    if (!removed.threw && removed.content === baselines.get(file.id)) {
      throw new Error(`${policyField} section does not affect managed file '${file.id}'`);
    }
  }
  if (policy.resolve && policy.resolve(undefined, {}) === undefined) {
    throw new Error(`${policyField}.resolve must produce a value`);
  }

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    const sections = implementation.sections ?? [];

    for (const section of sections) {
      const file = boundFiles.get(section.managedFile)!;
      const removed = renderFileContent(file, { [capability]: { render: false, variant: 'a' } });
      if (!removed.threw && removed.content === baselines.get(file.id)) {
        throw new Error(`${field} section does not affect managed file '${file.id}'`);
      }
    }

    let resolvedA: unknown;
    if (implementation.resolve) {
      resolvedA = implementation.resolve(probeInputs(capability, 'a') as never, probeEnvironment(capability));
      if (resolvedA === undefined) {
        throw new Error(`${field}.resolve must produce a value for the probe input`);
      }
    }

    let inputSensitive = false;
    for (const section of sections) {
      const file = boundFiles.get(section.managedFile)!;
      const variant = renderFileContent(file, { [capability]: { render: true, variant: 'b' } });
      if (variant.threw || variant.content !== baselines.get(file.id)) {
        inputSensitive = true;
        break;
      }
    }
    if (!inputSensitive && implementation.resolve) {
      const resolvedB = implementation.resolve(probeInputs(capability, 'b') as never, probeEnvironment(capability));
      inputSensitive = stableStringify(resolvedA) !== stableStringify(resolvedB);
    }
    if (!inputSensitive) {
      throw new Error(`${field} does not respond to its configuration input`);
    }
  }
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function contractName(name: string, field: string): string {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`${field} must be lowercase kebab-case`);
  }
  return name;
}

function requireFunction(value: unknown, field: string): void {
  if (typeof value !== 'function') throw new Error(`${field} must be a function`);
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.endsWith('/') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    value === '.'
  ) {
    throw new Error(`${field} must be a canonical relative path`);
  }
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function') return '[function]';
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return entry;
  });
}

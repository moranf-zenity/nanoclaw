/**
 * Container-runtime provider contracts.
 *
 * A contract is an implementation object, not a description: every declared
 * capability carries the function that implements it, and core calls those
 * functions at the declared moments.
 *
 * Registration itself is a map write. The optional shape checks and behavioral
 * probes live in verifier code, not in the startup registry path.
 */

import type { McpServerConfig, ProviderExchange } from '../providers/types.js';

export type RuntimeConfigurationCapabilityName = 'executionPolicy' | 'inference' | 'memory' | 'mcpServers';

/** Shared shape of the memory session-hook registration (structural mirror of memory/session-hook.ts). */
export interface RuntimeMemoryHookInput {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * Core-owned inputs for each configuration capability that has one.
 * `executionPolicy` is absent by design: it is a stance, not a function of
 * anything core varies, so it carries no input member.
 */
export interface RuntimeConfigurationInputs {
  inference: { model?: string; effort?: string; fastMode?: boolean };
  memory: RuntimeMemoryHookInput;
  mcpServers: Record<string, McpServerConfig>;
}

export interface RuntimeFileTransformInput {
  exists: boolean;
  content: string;
  filePath: string;
  /** Provider-passed opaque context (present on realize calls, absent in probes). */
  context: unknown;
  /** Rendered output of every configuration capability bound to this file. */
  sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>>;
}

export type RuntimeFileTransformResult = { kind: 'unchanged' } | { kind: 'replace'; content: string };

export interface RuntimeManagedFile {
  id: string;
  /** Directory the file lives under; the provider names it, core writes into it. */
  root(): string;
  relativePath: string;
  when: 'memory-session-hook-registration' | 'before-query';
  read: 'none' | 'text-if-present';
  /**
   * Legacy no-op. Core has exactly one way to write a managed file — replace
   * it in place — so this said nothing a provider could choose. Payloads
   * compiled before it was dropped may still pass it; core ignores it.
   */
  write?: 'direct-replace';
  /** Assembles the full file from prior content plus the rendered capability sections. */
  transform(input: RuntimeFileTransformInput): RuntimeFileTransformResult;
}

/** One file-carried piece of a configuration capability. */
export interface RuntimeCapabilitySection<I> {
  managedFile: string;
  render(input: I): unknown;
}

/**
 * How a provider implements one configuration capability. At least one
 * surface is required:
 *
 * - `sections` — file-carried: core renders each section from the core-owned
 *   input and hands it to the managed file's transform at write time.
 * - `resolve` — provider-runtime: a pure derivation of the provider's own
 *   configuration from the core-owned input; the provider's real code path
 *   must consume the same function.
 *
 * `probes` overrides the registry's default probe inputs when the default
 * fixtures cannot exercise the implementation (e.g. env-gated config).
 */
export interface RuntimeConfigurationCapability<I> {
  sections?: readonly RuntimeCapabilitySection<I>[];
  resolve?(input: I, environment: NodeJS.ProcessEnv): unknown;
  probes?: { a: I; b: I; environment?: NodeJS.ProcessEnv };
}

/**
 * A provider's sandbox/permission stance. Stating one is mandatory — it is a
 * fact every provider has — but a fixed stance says so with `value` instead of
 * a `resolve` that ignores what it is handed. `resolve` remains for a stance
 * that genuinely reads the environment.
 */
export interface RuntimeExecutionPolicyCapability {
  /** A constant stance. */
  value?: unknown;
  /** An environment-derived stance. */
  resolve?(input: void, environment: NodeJS.ProcessEnv): unknown;
  /** File-carried stance, rendered into a managed file. */
  sections?: readonly RuntimeCapabilitySection<void>[];
}

export interface ProviderRuntimeConfiguration {
  executionPolicy: RuntimeExecutionPolicyCapability;
  inference: RuntimeConfigurationCapability<RuntimeConfigurationInputs['inference']>;
  memory: RuntimeConfigurationCapability<RuntimeConfigurationInputs['memory']>;
  mcpServers: RuntimeConfigurationCapability<RuntimeConfigurationInputs['mcpServers']>;
}

/**
 * Effects a planner is handed instead of reaching for them. A planner stays
 * pure — probes and tests pass a fake clock, production passes the real one —
 * without the two-pass call protocol that negotiating clock samples required.
 */
export interface RuntimePlannerEffects {
  now(): number;
}

export interface RuntimeArchivePlan {
  relativePath: string;
  content: string;
  write: 'replace' | 'append';
  /**
   * Written ahead of `content` when core is creating the file. Core owns the
   * exists check, so a planner never asks whether its target is already there.
   */
  headerIfNew?: string;
}

/** Trigger-specific planner input: no planner is handed `unknown`. */
export interface RuntimePreCompactArchiveInput {
  transcriptContent: string;
  sessionsIndexContent?: string;
  sessionId?: string;
  assistantName?: string;
}

export interface RuntimeExchangeArchiveInput {
  exchange: ProviderExchange;
  /** Existing archive file names, so a planner can continue the newest one. */
  entries: readonly string[];
}

export type RuntimeArchives =
  | {
      trigger: 'pre-compact';
      plan(input: RuntimePreCompactArchiveInput, fx: RuntimePlannerEffects): RuntimeArchivePlan | null;
    }
  | {
      trigger: 'exchange-complete';
      plan(input: RuntimeExchangeArchiveInput, fx: RuntimePlannerEffects): RuntimeArchivePlan | null;
    };

export interface RuntimeContinuationRotationInput {
  size: number;
  firstLine: string;
  environment: NodeJS.ProcessEnv;
}

export interface RuntimeContinuationRotationPlan {
  reason?: string;
}
export type RuntimeContinuationRotationPlanner = (
  input: RuntimeContinuationRotationInput,
  fx: RuntimePlannerEffects,
) => RuntimeContinuationRotationPlan | null;

export interface ProviderRuntimeContract {
  /**
   * Wire version of the contract this payload was compiled against, checked
   * at the host↔container handshake. Absent means `1`, the version every
   * payload written before the field existed targets — read it through
   * `resolveProviderSeamVersion`, never directly.
   */
  seamVersion?: number;
  /** Files core writes for the provider. Empty when the provider manages no files. */
  managedFiles: readonly RuntimeManagedFile[];
  /** The four configuration responsibilities every provider must implement. */
  configuration: ProviderRuntimeConfiguration;
  /** Core-executed conversation archive; absent when the provider persists its own history. */
  archives?: RuntimeArchives;
  /** Core-executed continuation rotation; absent when the provider has no on-disk transcript. */
  continuationRotation?: {
    plan: RuntimeContinuationRotationPlanner;
    root(): string;
    searchSubdirectory: string;
    extension: string;
  };
  /** Provider trace locations core may read for diagnostics. Empty when none exist. */
  traceReaders: readonly { id: string; read(): string | null }[];
  textDelivery: 'mid-turn-complete' | 'result';
  /** How context compaction is observed; absent when the provider owns its context lifecycle opaquely. */
  compaction?: 'provider-hook' | 'provider-native';
  commands: {
    formatting: 'native' | 'xml';
    nativeAdmin: readonly string[];
    nativeFiltered: readonly string[];
  };
}

const contracts = new Map<string, ProviderRuntimeContract>();

/** The capabilities core hands an input to. `executionPolicy` is not one. */
const INPUT_CAPABILITY_NAMES = ['inference', 'memory', 'mcpServers'] as const;

export function registerProviderRuntimeContract(name: string, contract: ProviderRuntimeContract): void {
  const key = providerKey(name);
  if (contracts.has(key)) throw new Error(`Provider runtime contract already registered: ${key}`);
  contracts.set(key, deepFreeze(contract));
}

/**
 * The seam version core itself implements. Bumped to 2 when the archive and
 * rotation planners became single-call and typed per trigger: a payload built
 * against seam 1 expects the old multi-call protocol, so core must not drive
 * its planners.
 */
export const RUNTIME_SEAM_VERSION = 2;

/**
 * The seam version a contract targets. A payload compiled before the field
 * existed declares nothing and targets `1`; core never reads the raw field.
 */
export function resolveProviderSeamVersion(contract: ProviderRuntimeContract): number {
  return contract.seamVersion ?? 1;
}

export function getProviderRuntimeContract(name: string | null | undefined): ProviderRuntimeContract | undefined {
  return name ? contracts.get(name.toLowerCase()) : undefined;
}

export function hasDeclaredProviderRuntimeContract(name: string | null | undefined): boolean {
  return getProviderRuntimeContract(name) !== undefined;
}

export function listProviderRuntimeContractNames(): string[] {
  return [...contracts.keys()];
}

export function listProviderRuntimeContracts(): readonly ProviderRuntimeContract[] {
  return [...contracts.values()];
}

export function listRegisteredTraceReaders(): readonly (() => string | null)[] {
  const readers: (() => string | null)[] = [];
  for (const contract of contracts.values()) {
    for (const trace of contract.traceReaders) readers.push(trace.read);
  }
  return readers;
}

/**
 * Build the rendered capability sections for one managed file from the
 * core-owned inputs. A capability renders only when its input is present;
 * `executionPolicy` has no input to be present.
 */
export function renderManagedFileSections(
  contract: ProviderRuntimeContract,
  file: RuntimeManagedFile,
  inputs: Partial<RuntimeConfigurationInputs>,
): Partial<Record<RuntimeConfigurationCapabilityName, unknown>> {
  const sections: Partial<Record<RuntimeConfigurationCapabilityName, unknown>> = {};
  const policySection = (contract.configuration.executionPolicy.sections ?? []).find(
    (candidate) => candidate.managedFile === file.id,
  );
  if (policySection) sections.executionPolicy = policySection.render();
  for (const capability of INPUT_CAPABILITY_NAMES) {
    const section = (contract.configuration[capability].sections ?? []).find(
      (candidate) => candidate.managedFile === file.id,
    );
    if (!section) continue;
    if (!(capability in inputs)) {
      throw new Error(`Managed file '${file.id}' needs the ${capability} input, which was not provided`);
    }
    sections[capability] = (section.render as (input: unknown) => unknown)(inputs[capability]);
  }
  return sections;
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

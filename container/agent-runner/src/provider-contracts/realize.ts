import fs from 'fs';
import path from 'path';

import {
  RUNTIME_SEAM_VERSION,
  getProviderRuntimeContract,
  listRegisteredTraceReaders,
  renderManagedFileSections,
  resolveProviderSeamVersion,
  type ProviderRuntimeContract,
  type RuntimeArchivePlan,
  type RuntimeConfigurationInputs,
  type RuntimeManagedFile,
  type RuntimePlannerEffects,
} from './registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, ProviderExchange } from '../providers/types.js';

/** The production clock handed to planners; probes and tests pass a fake. */
const REAL_CLOCK: RuntimePlannerEffects = { now: () => Date.now() };

/**
 * The configuration inputs are one object per provider instance, created in
 * the factory from the construction options. The render path closes over that
 * object directly, so nothing is looked up while a file is being written.
 *
 * This map exists for exactly one caller: the memory-session-hook
 * registration, which reaches the seam after construction holding nothing but
 * the instance. That one cannot be a closure without changing what
 * `createProvider` returns, so it stays an explicit, single lookup.
 */
const providerInputs = new WeakMap<AgentProvider, Partial<RuntimeConfigurationInputs>>();

export function bindProviderRuntimeInputs(
  instance: AgentProvider,
  inputs: Partial<RuntimeConfigurationInputs>,
): void {
  providerInputs.set(instance, inputs);
}

export function realizeProviderManagedFiles(
  provider: string,
  when: RuntimeManagedFile['when'],
  context: unknown,
  inputs: Partial<RuntimeConfigurationInputs> = {},
): void {
  const contract = getProviderRuntimeContract(provider);
  if (!contract || contract.managedFiles.length === 0) return;
  const preparedDirectories = new Set<string>();

  for (const file of contract.managedFiles) {
    if (file.when !== when) continue;
    const filePath = resolveContainedPath(
      file.root(),
      file.relativePath,
      `Provider '${provider}' managed file '${file.id}' returned unsafe path`,
    );
    const directory = path.dirname(filePath);
    if (!preparedDirectories.has(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      preparedDirectories.add(directory);
    }
    let exists = false;
    let content = '';
    if (file.read === 'text-if-present') {
      exists = fs.existsSync(filePath);
      if (exists) content = fs.readFileSync(filePath, 'utf-8');
    }
    const result = file.transform({
      exists,
      content,
      context,
      filePath,
      sections: renderManagedFileSections(contract, file, inputs),
    });
    if (result.kind === 'replace') fs.writeFileSync(filePath, result.content);
  }
}

export function registerProviderMemorySessionHook(
  providerName: string,
  provider: AgentProvider,
  hook: MemorySessionHookRegistration,
): void {
  const inputs = providerInputs.get(provider) ?? {};
  inputs.memory = hook;
  providerInputs.set(provider, inputs);
  realizeProviderManagedFiles(providerName, 'memory-session-hook-registration', hook, inputs);
  provider.registerMemorySessionHook(hook);
}

export function newestRegisteredTrace(): string | null {
  for (const reader of listRegisteredTraceReaders()) {
    const found = reader();
    if (found) return found;
  }
  return null;
}

export function archiveProviderTranscript(
  provider: string,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName: string | undefined,
  log: (message: string) => void,
): boolean {
  const contract = getProviderRuntimeContract(provider);
  const planner = contract?.archives?.trigger === 'pre-compact' ? contract.archives.plan : undefined;
  if (!planner) return false;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    let sessionsIndexContent: string | undefined;
    if (fs.existsSync(indexPath)) {
      try {
        sessionsIndexContent = fs.readFileSync(indexPath, 'utf-8');
      } catch {
        // Transcript archival remains best-effort when the optional index is unreadable.
      }
    }
    const plan = planner({ transcriptContent, sessionsIndexContent, sessionId, assistantName }, REAL_CLOCK);
    if (!plan) return false;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    const target = resolveContainedPath(conversationsDir, plan.relativePath, 'Archive planner returned unsafe path');
    fs.mkdirSync(conversationsDir, { recursive: true });
    writeArchivePlan(target, plan);
    log(`Archived conversation to ${plan.relativePath}`);
    return true;
  } catch (error) {
    log(`Failed to archive transcript: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function archiveProviderExchangeFromContract(provider: string, exchange: ProviderExchange): string | null {
  const contract = getProviderRuntimeContract(provider);
  const archives = contract?.archives;
  if (!contract || archives?.trigger !== 'exchange-complete') return null;
  if (resolveProviderSeamVersion(contract) < 2) {
    console.error(
      `[${provider}-provider] payload targets provider seam ${resolveProviderSeamVersion(contract)}, ` +
        `core implements ${RUNTIME_SEAM_VERSION}: exchange archiving is skipped until the payload is refreshed ` +
        '(run /update-skills)',
    );
    return null;
  }

  const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
  // No mkdir to make this readable: a missing directory simply has no entries.
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(conversationsDir);
  } catch {
    // First archive of a session: nothing to continue.
  }
  const plan = archives.plan({ exchange, entries }, REAL_CLOCK);
  if (!plan) return null;

  const target = resolveContainedPath(conversationsDir, plan.relativePath, 'Archive planner returned unsafe path');
  fs.mkdirSync(conversationsDir, { recursive: true });
  writeArchivePlan(target, plan);
  return plan.relativePath;
}

export function maybeRotateProviderContinuation(
  provider: string,
  continuation: string,
  assistantName: string | undefined,
  log: (message: string) => void,
): string | null {
  const contract = getProviderRuntimeContract(provider);
  const rotation = contract?.continuationRotation;
  if (!rotation) return null;

  const transcriptPath = findContinuationFile(
    path.join(rotation.root(), rotation.searchSubdirectory),
    `${continuation}${rotation.extension}`,
  );
  if (!transcriptPath) return null;

  try {
    const size = fs.statSync(transcriptPath).size;
    let firstLine = '';
    try {
      firstLine = readFirstLine(transcriptPath);
    } catch {
      // Size-only rotation must survive an unreadable first entry.
    }
    const plan = rotation.plan({ size, firstLine, environment: process.env }, REAL_CLOCK);
    if (!plan?.reason) return null;

    archiveProviderTranscript(provider, transcriptPath, continuation, assistantName, log);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (error) {
      log(`Failed to move rotated transcript aside: ${error instanceof Error ? error.message : String(error)}`);
    }
    return plan.reason;
  } catch {
    return null;
  }
}

function findContinuationFile(root: string, fileName: string): string | null {
  let directories: string[];
  try {
    directories = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = path.join(root, directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readFirstLine(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf-8', 0, bytes).split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Core owns the write, including whether the file is being created: a plan
 * says what the file should contain and what to prepend when it is new, and
 * never has to ask the filesystem anything itself.
 */
function writeArchivePlan(filePath: string, plan: RuntimeArchivePlan): void {
  if (plan.write === 'replace') {
    fs.writeFileSync(filePath, plan.content);
    return;
  }
  const header = plan.headerIfNew && !fs.existsSync(filePath) ? plan.headerIfNew : '';
  fs.appendFileSync(filePath, `${header}${plan.content}`);
}

function resolveContainedPath(root: string, relativePath: string, errorPrefix: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${errorPrefix} '${relativePath}'`);
  }
  return target;
}

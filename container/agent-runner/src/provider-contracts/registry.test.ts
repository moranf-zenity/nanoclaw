import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import './index.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import {
  archiveProviderExchangeFromContract,
  archiveProviderTranscript,
  newestRegisteredTrace,
  realizeProviderManagedFiles,
} from './realize.js';
import {
  RUNTIME_SEAM_VERSION,
  getProviderRuntimeContract,
  hasDeclaredProviderRuntimeContract,
  registerProviderRuntimeContract as storeProviderRuntimeContract,
  type ProviderRuntimeContract,
  type RuntimeArchivePlan,
  type RuntimeExchangeArchiveInput,
  type RuntimeManagedFile,
  type RuntimePlannerEffects,
  type RuntimePreCompactArchiveInput,
} from './registry.js';
import { assertProviderRuntimeContractShape, probeProviderRuntimeConfiguration } from './verifier.js';

/**
 * Storing a contract is a map write; the shape check and the behavioral probes
 * are what the install-time verifier and this suite run over it. Every case
 * below goes through that checked path, which is the only place those errors
 * are raised now — container startup no longer runs them.
 */
function registerProviderRuntimeContract(name: string, contract: ProviderRuntimeContract): void {
  assertProviderRuntimeContractShape(name, contract);
  probeProviderRuntimeConfiguration(name, contract);
  storeProviderRuntimeContract(name, contract);
}

function emptyContract(): ProviderRuntimeContract {
  return {
    seamVersion: RUNTIME_SEAM_VERSION,
    managedFiles: [],
    configuration: {
      executionPolicy: { resolve: () => ({ boundary: 'container' }) },
      inference: { resolve: (input) => ({ model: input.model, effort: input.effort }) },
      memory: { resolve: (input) => ({ command: input.command }) },
      mcpServers: { resolve: (input) => ({ servers: Object.keys(input) }) },
    },
    traceReaders: [],
    textDelivery: 'result',
    commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
  };
}

function coreArchiveContract(trigger: 'exchange-complete', plan: ExchangePlanner): ProviderRuntimeContract;
function coreArchiveContract(trigger: 'pre-compact', plan: PreCompactPlanner): ProviderRuntimeContract;
function coreArchiveContract(
  trigger: 'pre-compact' | 'exchange-complete',
  plan: ExchangePlanner | PreCompactPlanner,
): ProviderRuntimeContract {
  return {
    ...emptyContract(),
    archives:
      trigger === 'exchange-complete'
        ? { trigger, plan: plan as ExchangePlanner }
        : { trigger, plan: plan as PreCompactPlanner },
    ...(trigger === 'pre-compact' ? { compaction: 'provider-hook' as const } : {}),
  };
}

type ExchangePlanner = (
  input: RuntimeExchangeArchiveInput,
  fx: RuntimePlannerEffects,
) => RuntimeArchivePlan | null;
type PreCompactPlanner = (
  input: RuntimePreCompactArchiveInput,
  fx: RuntimePlannerEffects,
) => RuntimeArchivePlan | null;

/** A planner clock that never moves, so archive names are assertable. */
function fixedClock(ms: number): RuntimePlannerEffects {
  return { now: () => ms };
}

function managedFile(overrides: Partial<RuntimeManagedFile>): RuntimeManagedFile {
  return {
    id: 'settings',
    root: () => '/tmp',
    relativePath: 'settings.json',
    when: 'before-query',
    read: 'none',
    transform: ({ sections }) => ({ kind: 'replace', content: JSON.stringify(sections) + '\n' }),
    ...overrides,
  };
}

function contractName(field: string, suffix: string): string {
  return `runtime-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider runtime contracts', () => {
  it('loads the complete Claude implementation from the separate contract barrel', () => {
    const contract = getProviderRuntimeContract('claude');
    expect(contract).toBeDefined();
    expect(contract?.managedFiles).toHaveLength(1);
    const settings = contract!.managedFiles[0];
    expect(settings.id).toBe('memory-session-hook');
    expect(settings.relativePath).toBe('settings.json');
    expect(settings.when).toBe('memory-session-hook-registration');
    expect(settings.read).toBe('text-if-present');
    expect(typeof settings.root).toBe('function');
    expect(typeof settings.transform).toBe('function');

    expect(contract?.configuration.executionPolicy.resolve).toBeUndefined();
    expect(contract?.configuration.executionPolicy.sections).toBeUndefined();
    expect(contract?.configuration.executionPolicy.value).toBeDefined();
    expect(typeof contract?.configuration.inference.resolve).toBe('function');
    expect(typeof contract?.configuration.mcpServers.resolve).toBe('function');
    expect(contract?.configuration.memory.sections).toHaveLength(1);
    expect(contract?.configuration.memory.sections?.[0].managedFile).toBe('memory-session-hook');
    expect(typeof contract?.configuration.memory.resolve).toBe('function');

    expect(contract?.archives?.trigger).toBe('pre-compact');
    expect(typeof contract?.archives?.plan).toBe('function');
    expect(contract?.continuationRotation?.searchSubdirectory).toBe('projects');
    expect(contract?.continuationRotation?.extension).toBe('.jsonl');
    expect(contract?.traceReaders.map((trace) => trace.id)).toEqual(['claude-home']);
    expect(contract?.textDelivery).toBe('mid-turn-complete');
    expect(contract?.compaction).toBe('provider-hook');
    expect(contract?.commands.formatting).toBe('native');
    expect(hasDeclaredProviderRuntimeContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderRuntimeContract('legacy')).toBe(false);
  });

  it('resolves Claude execution policy, inference, and MCP config through the contract functions', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const policy = contract.configuration.executionPolicy.value as {
      permissionMode: string;
      disallowedTools: string[];
    };
    expect(policy.permissionMode).toBe('bypassPermissions');
    expect(policy.disallowedTools).toContain('AskUserQuestion');

    const inference = contract.configuration.inference.resolve!(
      { model: 'opus', effort: 'high', fastMode: true },
      {},
    );
    expect(inference).toEqual({ model: 'opus', effort: 'high', fastMode: true });

    const mcp = contract.configuration.mcpServers.resolve!({ nanoclaw: { command: 'bun' } }, {}) as {
      allowedTools: string[];
    };
    expect(mcp.allowedTools).toContain('mcp__nanoclaw__*');
  });

  it('rejects duplicate registrations', () => {
    const name = `runtime-contract-${process.pid}`;
    registerProviderRuntimeContract(name, emptyContract());
    expect(() => registerProviderRuntimeContract(name, emptyContract())).toThrow(/already registered/);
  });

  it('rejects non-kebab-case provider names', () => {
    expect(() => registerProviderRuntimeContract('Runtime Bad Name', emptyContract())).toThrow(/kebab-case/);
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `runtime-immutable-${process.pid}`;
    registerProviderRuntimeContract(name, emptyContract());
    const stored = getProviderRuntimeContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('rejects capabilities without any implementation surface', () => {
    const contract = emptyContract();
    contract.configuration.inference = {};
    expect(() => registerProviderRuntimeContract(contractName('configuration-empty', 'invalid'), contract)).toThrow(
      /configuration\.inference must implement at least one surface/,
    );
  });

  it('rejects a missing configuration block and missing capabilities', () => {
    const missingBlock = emptyContract() as unknown as { configuration?: unknown };
    delete missingBlock.configuration;
    expect(() =>
      registerProviderRuntimeContract(
        contractName('configuration-block', 'missing'),
        missingBlock as ProviderRuntimeContract,
      ),
    ).toThrow(/configuration is required/);

    const missingCapability = emptyContract() as unknown as {
      configuration: Record<string, unknown>;
    };
    delete missingCapability.configuration.memory;
    expect(() =>
      registerProviderRuntimeContract(
        contractName('configuration-memory', 'missing'),
        missingCapability as unknown as ProviderRuntimeContract,
      ),
    ).toThrow(/configuration\.memory is required/);
  });

  it('rejects sections that reference missing managed files', () => {
    const contract = emptyContract();
    contract.configuration.memory = {
      sections: [{ managedFile: 'missing-file', render: (hook) => hook }],
    };
    expect(() => registerProviderRuntimeContract(contractName('configuration-file', 'missing'), contract)).toThrow(
      /configuration\.memory references missing managed file 'missing-file'/,
    );
  });

  it('rejects managed files with non-function surfaces and invalid enums', () => {
    const base = emptyContract();
    expect(() =>
      registerProviderRuntimeContract(contractName('managed-transform', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ transform: 'invalid' as unknown as RuntimeManagedFile['transform'] })],
      }),
    ).toThrow(/managedFiles\.settings\.transform must be a function/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-root', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ root: 'invalid' as unknown as RuntimeManagedFile['root'] })],
      }),
    ).toThrow(/managedFiles\.settings\.root must be a function/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-when', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ when: 'invalid' as RuntimeManagedFile['when'] })],
      }),
    ).toThrow(/managedFiles\.settings\.when/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-read', 'invalid'), {
        ...base,
        managedFiles: [managedFile({ read: 'invalid' as RuntimeManagedFile['read'] })],
      }),
    ).toThrow(/managedFiles\.settings\.read/);

    expect(() =>
      registerProviderRuntimeContract(contractName('managed-duplicate', 'invalid'), {
        ...base,
        managedFiles: [managedFile({}), managedFile({ relativePath: 'other.json' })],
      }),
    ).toThrow(/managedFiles\[\]\.id must be unique/);
  });

  it.each([
    ['dot', './settings.json'],
    ['bare-parent', '..'],
    ['leading-parent', '../settings.json'],
    ['parent', 'config/../settings.json'],
    ['slash', 'config//settings.json'],
    ['trailing', 'config/'],
  ])('rejects noncanonical managed-file relative path %s', (label, relativePath) => {
    expect(() =>
      registerProviderRuntimeContract(contractName('managed-relative-path', label), {
        ...emptyContract(),
        managedFiles: [managedFile({ relativePath })],
      }),
    ).toThrow(/canonical relative path/);
  });

  it('rejects invalid text delivery, compaction, and command declarations', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('text-delivery', 'invalid'), {
        ...emptyContract(),
        textDelivery: 'invalid' as ProviderRuntimeContract['textDelivery'],
      }),
    ).toThrow(/textDelivery/);

    expect(() =>
      registerProviderRuntimeContract(contractName('compaction', 'invalid'), {
        ...emptyContract(),
        compaction: 'invalid' as ProviderRuntimeContract['compaction'],
      }),
    ).toThrow(/compaction/);

    expect(() =>
      registerProviderRuntimeContract(contractName('commands-formatting', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'invalid' as 'xml', nativeAdmin: [], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.formatting/);

    expect(() =>
      registerProviderRuntimeContract(contractName('commands-native', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'xml', nativeAdmin: ['bad command'], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.nativeAdmin/);
  });

  it('rejects a pre-compact archive without a provider-hook compaction', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('archives-compaction', 'invalid'), {
        ...emptyContract(),
        archives: { trigger: 'pre-compact', plan: () => null },
      }),
    ).toThrow(/pre-compact trigger requires compaction 'provider-hook'/);
  });

  it('rejects invalid continuation-rotation declarations', () => {
    expect(() =>
      registerProviderRuntimeContract(contractName('rotation-extension', 'invalid'), {
        ...emptyContract(),
        continuationRotation: {
          plan: () => null,
          root: () => '/tmp',
          searchSubdirectory: 'projects',
          extension: 'jsonl',
        },
      }),
    ).toThrow(/extension must be a file extension/);
  });

  describe('registration probes', () => {
    it('rejects a section the managed file transform ignores', () => {
      const contract = emptyContract();
      contract.managedFiles = [
        managedFile({
          transform: ({ sections }) => ({
            kind: 'replace',
            content: JSON.stringify({ memory: sections.memory }) + '\n',
          }),
        }),
      ];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
      };
      contract.configuration.inference = {
        sections: [{ managedFile: 'settings', render: (input) => input }],
      };
      expect(() => registerProviderRuntimeContract(contractName('probe-dead-section', 'invalid'), contract)).toThrow(
        /configuration\.inference section does not affect managed file 'settings'/,
      );
    });

    it('rejects a capability that ignores its configuration input', () => {
      const contract = emptyContract();
      contract.configuration.inference = { resolve: () => ({ constant: true }) };
      expect(() => registerProviderRuntimeContract(contractName('probe-insensitive', 'invalid'), contract)).toThrow(
        /configuration\.inference does not respond to its configuration input/,
      );
    });

    it('rejects a resolve that produces no value', () => {
      const contract = emptyContract();
      contract.configuration.executionPolicy = { resolve: () => undefined };
      expect(() => registerProviderRuntimeContract(contractName('probe-undefined', 'invalid'), contract)).toThrow(
        /configuration\.executionPolicy\.resolve must produce a value/,
      );
    });

    it('rejects a bound managed file whose transform cannot produce initial content', () => {
      const contract = emptyContract();
      contract.managedFiles = [managedFile({ transform: () => ({ kind: 'unchanged' }) })];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
      };
      expect(() => registerProviderRuntimeContract(contractName('probe-unchanged', 'invalid'), contract)).toThrow(
        /transform must produce content from an empty state/,
      );
    });

    it('honors declared probe fixtures and probe environments', () => {
      const seenEnvironments: Array<Record<string, string | undefined>> = [];
      const effortOnly = (input: { model?: string; effort?: string }, environment: NodeJS.ProcessEnv): unknown => {
        seenEnvironments.push({ ...environment });
        return { effort: input.effort ?? 'none' };
      };

      const withoutProbes = emptyContract();
      withoutProbes.configuration.inference = { resolve: effortOnly };
      expect(() =>
        registerProviderRuntimeContract(contractName('probe-defaults-miss', 'invalid'), withoutProbes),
      ).toThrow(/configuration\.inference does not respond/);

      const withProbes = emptyContract();
      withProbes.configuration.inference = {
        resolve: effortOnly,
        probes: { a: { effort: 'low' }, b: { effort: 'high' }, environment: { NANOCLAW_PROBE: 'set' } },
      };
      registerProviderRuntimeContract(contractName('probe-defaults-hit', 'valid'), withProbes);
      expect(seenEnvironments.at(-1)?.NANOCLAW_PROBE).toBe('set');
    });

    it('accepts a capability whose sensitivity lives in a section while its resolve is constant', () => {
      const contract = emptyContract();
      contract.managedFiles = [
        managedFile({
          transform: ({ sections }) => {
            if (!sections.memory) throw new Error('memory section required');
            return { kind: 'replace', content: JSON.stringify(sections.memory) + '\n' };
          },
        }),
      ];
      contract.configuration.memory = {
        sections: [{ managedFile: 'settings', render: (hook) => hook }],
        resolve: () => ({ disabled: true }),
      };
      registerProviderRuntimeContract(contractName('probe-section-sensitive', 'valid'), contract);
    });
  });

  it('honors managed-file read policy and preserves config-before-hooks failure ordering', () => {
    const name = `runtime-managed-files-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const configPath = path.join(root, 'config.toml');
    const hooksPath = path.join(root, 'hooks.json');
    const calls: string[] = [];
    const originalExistsSync = fs.existsSync.bind(fs);

    registerProviderRuntimeContract(name, {
      ...emptyContract(),
      managedFiles: [
        managedFile({
          id: 'config',
          root: () => root,
          relativePath: 'config.toml',
          read: 'none',
          transform: ({ exists, content }) => {
            calls.push(`config:${exists}:${content}`);
            return { kind: 'replace', content: 'new config\n' };
          },
        }),
        managedFile({
          id: 'hooks',
          root: () => root,
          relativePath: 'hooks.json',
          read: 'text-if-present',
          transform: ({ exists, content }) => {
            calls.push(`hooks:${exists}:${content}`);
            JSON.parse(content || '{}');
            return { kind: 'replace', content: '{"hooks":true}\n' };
          },
        }),
      ],
    });

    try {
      fs.writeFileSync(configPath, 'stale config');
      fs.writeFileSync(hooksPath, '{}');
      const mkdirSpy = spyOn(fs, 'mkdirSync');
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation((candidate) => {
        if (candidate === configPath) throw new Error('config existence must not be checked');
        return originalExistsSync(candidate);
      });
      try {
        realizeProviderManagedFiles(name, 'before-query', {});
        expect(mkdirSpy).toHaveBeenCalledTimes(1);
      } finally {
        existsSpy.mockRestore();
        mkdirSpy.mockRestore();
      }
      expect(calls).toEqual(['config:false:', 'hooks:true:{}']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{"hooks":true}\n');

      calls.length = 0;
      fs.writeFileSync(configPath, 'stale again');
      fs.writeFileSync(hooksPath, '{');
      expect(() => realizeProviderManagedFiles(name, 'before-query', {})).toThrow();
      expect(calls).toEqual(['config:false:', 'hooks:true:{']);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('new config\n');
      expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decides empty transcript no-op before reading the optional sessions index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-noop-${process.pid}-`));
    const transcriptPath = path.join(root, 'empty.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '');

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', () => {})).toBe(false);
      fs.mkdirSync(path.join(root, 'sessions-index.json'));
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'empty', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(logs).toEqual([]);
      expect(fs.existsSync(conversationsDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names an unsummarized Claude archive from local time and dates the file locally across UTC rollover', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const plan = contract.archives!.trigger === 'pre-compact' ? contract.archives!.plan : undefined;
    // Prefer an instant whose local date differs from its UTC date, so a
    // filename built from the UTC date would be visibly wrong. In an install
    // running UTC no such instant exists, and the local-date assertion below
    // still pins the behavior.
    const candidates = [Date.parse('2027-02-03T23:59:59.900Z'), Date.parse('2027-02-04T00:00:00.100Z')];
    const rollover =
      candidates.find(
        (clockMs) =>
          formatLocalStamp(new Date(clockMs), TIMEZONE).slice(0, 10) !== new Date(clockMs).toISOString().slice(0, 10),
      ) ?? candidates[0];
    const archived = plan!(
      { transcriptContent: '{"type":"user","message":{"content":"hello"}}\n', assistantName: 'Claude' },
      fixedClock(rollover),
    )!;

    const at = new Date(rollover);
    const hour = at.getHours().toString().padStart(2, '0');
    const minute = at.getMinutes().toString().padStart(2, '0');
    expect(archived.relativePath).toBe(
      `${formatLocalStamp(at, TIMEZONE).slice(0, 10)}-conversation-${hour}${minute}.md`,
    );
    if (formatLocalStamp(at, TIMEZONE).slice(0, 10) !== at.toISOString().slice(0, 10)) {
      expect(archived.relativePath.slice(0, 10)).not.toBe(at.toISOString().slice(0, 10));
    }
    expect(archived.write).toBe('replace');
    expect(archived.content).toContain('**User**: hello');
  });

  it('names a summarized Claude archive from the summary', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const plan = contract.archives!.trigger === 'pre-compact' ? contract.archives!.plan : undefined;
    const archived = plan!(
      {
        transcriptContent: '{"type":"user","message":{"content":"hello"}}\n',
        sessionsIndexContent: '{"entries":[{"sessionId":"session","summary":"Useful Summary"}]}',
        sessionId: 'session',
      },
      fixedClock(Date.parse('2027-03-04T12:00:00.000Z')),
    )!;

    expect(archived.relativePath).toBe(
      `${formatLocalStamp(new Date(Date.parse('2027-03-04T12:00:00.000Z')), TIMEZONE).slice(0, 10)}-useful-summary.md`,
    );
  });

  it('reports a failed transcript archive write instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-blocked-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(conversationsDir, 'blocked');

    try {
      const logs: string[] = [];
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', (line) => logs.push(line))).toBe(
        false,
      );
      expect(logs[0]).toContain('Failed to archive transcript:');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives a transcript without a summary when the optional sessions index is unreadable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-index-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.mkdirSync(path.join(root, 'sessions-index.json'));

    try {
      expect(archiveProviderTranscript('claude', transcriptPath, 'session', 'Claude', () => {})).toBe(true);
      const [archive] = fs.readdirSync(conversationsDir);
      expect(fs.readFileSync(path.join(conversationsDir, archive), 'utf-8')).toContain('**User**: hello');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates nothing when the planner declines an exchange', () => {
    const name = `runtime-exchange-noop-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', ({ exchange }) =>
        exchange.result?.trim() ? { relativePath: 'exchange.md', content: exchange.result, write: 'append' } : null,
      ),
    );
    const mkdirSpy = spyOn(fs, 'mkdirSync');

    try {
      const empty = { prompt: 'hello', result: ' ', status: 'completed' as const };
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(fs.existsSync(conversationsDir)).toBe(false);
      // A conversations path that is a file, not a directory, is simply "no
      // entries" — reading it is not an error core has to pre-empt with mkdir.
      fs.writeFileSync(conversationsDir, 'not a directory');
      expect(archiveProviderExchangeFromContract(name, empty)).toBeNull();
      expect(mkdirSpy).toHaveBeenCalledTimes(0);
    } finally {
      mkdirSpy.mockRestore();
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('plans an exchange archive once, with the existing entries', () => {
    const name = `runtime-exchange-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.mkdirSync(conversationsDir, { recursive: true });
    fs.writeFileSync(path.join(conversationsDir, 'older.md'), 'older\n');
    const calls: Array<{ entries: readonly string[]; nowMs: number }> = [];
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', ({ entries }, fx) => {
        calls.push({ entries, nowMs: fx.now() });
        return { relativePath: 'exchange.md', content: 'archive', write: 'append' };
      }),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].entries).toEqual(['older.md']);
      expect(calls[0].nowMs).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces a blocked conversations path when it writes an exchange archive', () => {
    const name = `runtime-exchange-error-order-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(conversationsDir, 'blocked');
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: 'exchange.md',
        content: 'archive',
        write: 'append',
      })),
    );

    try {
      expect(() =>
        archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' }),
      ).toThrow(/EEXIST/);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows archive targets contained by the filesystem root', () => {
    const name = `runtime-exchange-root-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const target = path.join(root, 'exchange.md');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = path.parse(root).root;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: path.relative(path.parse(root).root, target),
        content: 'archive',
        write: 'append',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        path.relative(path.parse(root).root, target),
      );
      expect(fs.readFileSync(target, 'utf-8')).toBe('archive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes headerIfNew only when it creates the target, dangling symlink included', () => {
    const name = `runtime-exchange-header-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    // A dangling symlink is not an existing file: the header still belongs.
    fs.symlinkSync('archive-target.md', path.join(conversationsDir, 'exchange.md'));
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: 'exchange.md',
        content: 'archive',
        write: 'append',
        headerIfNew: 'header\n',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      const target = path.join(conversationsDir, 'archive-target.md');
      expect(fs.readFileSync(target, 'utf-8')).toBe('header\narchive');

      // Second exchange: the file exists now, so the header is not repeated.
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(target, 'utf-8')).toBe('header\narchivearchive');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it('reads Claude traces from the OS home even when CLAUDE_CONFIG_DIR diverges', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-trace-home-${process.pid}-`));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const homeTrace = path.join(home, '.claude', 'projects', 'home-project', 'home.jsonl');
    const configTrace = path.join(config, 'projects', 'config-project', 'config.jsonl');
    fs.mkdirSync(path.dirname(homeTrace), { recursive: true });
    fs.mkdirSync(path.dirname(configTrace), { recursive: true });
    fs.writeFileSync(homeTrace, '{}\n');
    fs.writeFileSync(configTrace, '{}\n');
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);

    try {
      expect(newestRegisteredTrace()).toBe(homeTrace);
    } finally {
      homedirSpy.mockRestore();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes a declared exchange archive plan', () => {
    const name = `runtime-exchange-archive-${process.pid}`;
    const conversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    registerProviderRuntimeContract(
      name,
      coreArchiveContract('exchange-complete', () => ({
        relativePath: 'exchange.md',
        content: 'archived\n',
        write: 'append',
      })),
    );

    try {
      expect(archiveProviderExchangeFromContract(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
        'exchange.md',
      );
      expect(fs.readFileSync(path.join(conversationsDir, 'exchange.md'), 'utf-8')).toBe('archived\n');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(conversationsDir, { recursive: true, force: true });
    }
  });
});

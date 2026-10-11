import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { format } from 'prettier';

import {
  assertPinnedRevision,
  COMPILE_STAGE_IDS,
  deadlineMinutesForMode,
  GN_DEADLINE_MINUTES,
  GN_STAGE_IDS,
  GN_SYNC_JOBS,
  isGithubHostedRunner,
  MAX_BUILD_JOBS,
  MAX_BROWSER_ARTIFACT_BYTES,
  milestoneVerdicts,
  parseValidationOptions,
  RESOURCE_POLL_INTERVAL_MS,
  resourceLimitReason,
  runMonitoredCommand,
  runValidation,
  RUNNER_SIZES,
  syncJobsForMode,
  TARGETED_CPP_TARGETS,
  VALIDATION_LEVELS,
  WEBUI_RESOURCE_OUTPUTS,
  WEBUI_RESOURCE_TARGETS,
} from '../../tools/chromium/ci-validation.mjs';
import { loadConfig, REPO_ROOT } from '../../tools/chromium/lib/config.mjs';
import {
  diskFloorGb,
  gclientSyncArgs,
  parseJobs,
} from '../../tools/chromium/sync.mjs';

const WORKFLOW_PATH = '.github/workflows/chromium-build.yml';
const WORKFLOW = readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8');
const DRIVER = readFileSync(
  path.join(REPO_ROOT, 'tools/chromium/ci-validation.mjs'),
  'utf8',
);
const CANONICAL_PATH = path.join(
  REPO_ROOT,
  'tools/ci/workflows/chromium-build.yml',
);

function tempDirectory() {
  return mkdtempSync(path.join(tmpdir(), 'aurelia-chromium-ci-'));
}

describe('hosted Chromium validation configuration', () => {
  it('accepts only the requested validation levels and runner sizes', () => {
    expect(VALIDATION_LEVELS).toEqual([
      'gn',
      'targeted-lite',
      'targeted',
      'full',
    ]);
    expect(RUNNER_SIZES).toEqual(['standard', 'larger']);
    expect(
      parseValidationOptions(
        [
          '--mode',
          'targeted',
          '--runner-size',
          'larger',
          '--dest',
          'checkout',
          '--artifacts',
          'artifacts',
        ],
        {},
      ),
    ).toMatchObject({ mode: 'targeted', runnerSize: 'larger' });
    expect(() =>
      parseValidationOptions(
        [
          '--mode',
          'everything',
          '--dest',
          'checkout',
          '--artifacts',
          'artifacts',
        ],
        {},
      ),
    ).toThrow('invalid validation level');
    expect(() =>
      parseValidationOptions(
        [
          '--mode',
          'gn',
          '--runner-size',
          'self-hosted',
          '--dest',
          'checkout',
          '--artifacts',
          'artifacts',
        ],
        {},
      ),
    ).toThrow('invalid runner size');
    expect(() => parseValidationOptions(['--mode', 'full'], {})).toThrow(
      '--dest <directory> is required',
    );
  });

  it('allows compilation only in a GitHub-hosted Actions runner environment', () => {
    expect(
      isGithubHostedRunner({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
      }),
    ).toBe(true);
    expect(
      isGithubHostedRunner({
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'self-hosted',
      }),
    ).toBe(false);
    expect(isGithubHostedRunner({})).toBe(false);
  });

  it('has only manual dispatch, selectable levels, and a GN default', () => {
    expect(WORKFLOW).toContain('workflow_dispatch:');
    expect(WORKFLOW).toMatch(/validation_level:\s*\n[\s\S]*?type:\s*choice/);
    expect(WORKFLOW).toMatch(/options:\s*\n\s+- gn\n\s+- targeted\n\s+- full/);
    expect(WORKFLOW).toMatch(/default:\s*gn/);
    expect(WORKFLOW).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(WORKFLOW).toContain('timeout-minutes: 360');
    expect(WORKFLOW).toContain('cancel-in-progress: false');
  });

  it('pins runner selection to GitHub-hosted Windows labels and read-only permissions', () => {
    expect(WORKFLOW).toContain(
      "runs-on: ${{ inputs.runner_size == 'larger' && 'windows-latest-8-cores' || 'windows-2025' }}",
    );
    expect(WORKFLOW).toContain('permissions:\n  contents: read');
    expect(WORKFLOW).toContain("DEPOT_TOOLS_WIN_TOOLCHAIN: '0'");
    expect(DRIVER).toContain("DEPOT_TOOLS_WIN_TOOLCHAIN: '0'");
    expect(WORKFLOW).not.toMatch(/runs-on:.*self-hosted/);
    expect(WORKFLOW).not.toMatch(/secrets\./);
    expect(WORKFLOW).toContain('persist-credentials: false');
    expect(WORKFLOW).toContain('$exitCode = $LASTEXITCODE');
    expect(WORKFLOW).toContain('exit $exitCode');
  });

  it('keeps the deployed workflow byte-identical to its canonical definition', () => {
    expect(readFileSync(CANONICAL_PATH, 'utf8')).toBe(WORKFLOW);
  });

  it('parses as YAML and includes an always-run logs and summary upload', async () => {
    await expect(format(WORKFLOW, { parser: 'yaml' })).resolves.toBeTypeOf(
      'string',
    );
    expect(WORKFLOW).toContain('if: always()');
    expect(WORKFLOW).toContain('path: artifacts/');
    expect(WORKFLOW).toContain('retention-days: 7');
    expect(WORKFLOW).toContain('actions/upload-artifact@');
  });

  it('gates explicit full compilation behind same-run GN and targeted validation', () => {
    const start = DRIVER.indexOf('const gnArgsFile');
    const end = DRIVER.indexOf("writeSummary(context, 'PASS')", start);
    const execution = DRIVER.slice(start, end);
    const markers = [
      "id: 'gn-argument-policy'",
      "id: 'depot-tools-bootstrap'",
      "id: 'gn-generation'",
      "id: 'gn-effective-arguments'",
      "setStage(context, 'target-labels', 'RUNNING'",
      "setStage(context, 'gn-check', 'RUNNING'",
      "id: 'webui-resources'",
      "if (mode === 'targeted' || mode === 'full')",
      "id: 'targeted-cpp'",
      "if (mode === 'full')",
      "id: 'full-chrome'",
    ];
    let cursor = -1;
    for (const marker of markers) {
      const index = execution.indexOf(marker, cursor + 1);
      expect(index, `validation order is missing ${marker}`).toBeGreaterThan(
        -1,
      );
      expect(index, `validation order is wrong for ${marker}`).toBeGreaterThan(
        cursor,
      );
      cursor = index;
    }
  });

  it('blocks local and self-hosted execution before pinned source sync', () => {
    const environmentGate = DRIVER.indexOf('if (!isGithubHostedRunner())');
    const syncStage = DRIVER.indexOf("id: 'pinned-sync'");
    expect(environmentGate).toBeGreaterThan(-1);
    expect(syncStage).toBeGreaterThan(environmentGate);
    expect(DRIVER).toContain('RUNNER_ENVIRONMENT');
  });

  it('invokes the existing Chromium preparation tools and writes no source artifact', () => {
    expect(WORKFLOW).toContain('tools/chromium/ci-validation.mjs');
    expect(DRIVER).toContain("'tools/chromium/sync.mjs'");
    expect(DRIVER).toContain("'tools/chromium/install-overlay.mjs'");
    expect(DRIVER).toContain("'tools/chromium/cli.mjs'");
    expect(DRIVER).toContain("'tools/chromium/gn-args.mjs'");
    expect(WORKFLOW).not.toContain('chromium/src/**');
    expect(WORKFLOW).not.toContain('upload full source');
    expect(WORKFLOW).toContain('path: artifacts/');
  });
});

describe('pinned Chromium target and resource validation', () => {
  it('uses the repository pin and refuses any different checkout SHA', () => {
    const config = loadConfig();
    expect(config.chromium.version).toBe('155.0.8059.40');
    expect(config.chromium.revision).toBe(
      'cfaadc5a132d78e1828635aa8405a499f3e14864',
    );
    expect(
      assertPinnedRevision(config.chromium.revision, config.chromium.revision),
    ).toBe(config.chromium.revision);
    expect(() =>
      assertPinnedRevision(config.chromium.revision, '0'.repeat(40)),
    ).toThrow('refusing to continue');
  });

  it('bounds sync concurrency and exposes mode-aware disk floors', () => {
    expect(MAX_BUILD_JOBS).toBe(4);
    // Default (no mode/full) keeps the reference 150 GB floor.
    expect(diskFloorGb()).toBe(150);
    // targeted/full keep the unchanged 150 GB reference floor.
    expect(diskFloorGb({ config: loadConfig(), mode: 'full' })).toBe(150);
    expect(diskFloorGb({ config: loadConfig(), mode: 'targeted' })).toBe(150);
    // gn uses a mode-specific floor read from config.
    const gnFloor = diskFloorGb({ config: loadConfig(), mode: 'gn' });
    expect(gnFloor).toBeLessThan(150);
    expect(gnFloor).toBeGreaterThanOrEqual(50);
    // gclient sync args include --no-history when requested (GN mode default).
    expect(
      gclientSyncArgs({
        revision: 'cfaadc5a132d78e1828635aa8405a499f3e14864',
        jobs: 4,
      }),
    ).toEqual([
      'sync',
      '--jobs',
      '4',
      '--revision',
      'src@cfaadc5a132d78e1828635aa8405a499f3e14864',
    ]);
    expect(
      gclientSyncArgs({
        revision: 'cfaadc5a132d78e1828635aa8405a499f3e14864',
        jobs: 2,
        noHistory: true,
      }),
    ).toEqual([
      'sync',
      '--jobs',
      '2',
      '--revision',
      'src@cfaadc5a132d78e1828635aa8405a499f3e14864',
      '--no-history',
    ]);
    expect(() => gclientSyncArgs({ revision: 'bad', jobs: 0 })).toThrow(
      '--jobs must be an integer',
    );
    expect(parseJobs('4')).toBe(4);
    expect(() => parseJobs('four')).toThrow('--jobs must be an integer');
    expect(() => parseJobs('0')).toThrow('--jobs must be an integer');
    expect(WEBUI_RESOURCE_TARGETS).toEqual([
      '//chrome/browser/resources/aurelia:build_ts',
      '//chrome/browser/resources/aurelia:build_grd',
      '//chrome/browser/resources/aurelia:resources',
      '//chrome/browser/resources/newtab:build_ts',
      '//chrome/browser/resources/newtab:build_grd',
      '//chrome/browser/resources/newtab:resources',
    ]);
    expect(TARGETED_CPP_TARGETS).toEqual([
      '//chrome/browser/ui/webui/aurelia:aurelia',
      '//chrome/browser/ui/webui/newtab:newtab',
    ]);
    expect(WEBUI_RESOURCE_OUTPUTS).toContain(
      'gen/chrome/aurelia_resources.pak',
    );
    expect(WEBUI_RESOURCE_OUTPUTS).toContain(
      'gen/chrome/aurelia_newtab_resources.pak',
    );
  });

  it('stops and reports measured disk or memory exhaustion', () => {
    expect(
      resourceLimitReason({ freeDiskGb: 14, availableMemoryGb: 8 }),
    ).toContain('free disk');
    expect(
      resourceLimitReason({ freeDiskGb: 100, availableMemoryGb: 1 }),
    ).toContain('available memory');
    expect(
      resourceLimitReason({ freeDiskGb: 100, availableMemoryGb: 8 }),
    ).toBeNull();
    expect(
      resourceLimitReason({ freeDiskGb: null, availableMemoryGb: 8 }),
    ).toContain('free disk could not be measured');
    expect(
      resourceLimitReason({ freeDiskGb: 100, availableMemoryGb: null }),
    ).toContain('available memory could not be measured');
    expect(RESOURCE_POLL_INTERVAL_MS).toBe(30_000);
    expect(MAX_BROWSER_ARTIFACT_BYTES).toBe(450 * 1024 ** 2);
  });

  it('propagates a compiler or GN process failure instead of downgrading it to a warning', async () => {
    const root = tempDirectory();
    const logs = path.join(root, 'logs');
    mkdirSync(logs);
    const usagePath = path.join(root, 'resource-usage.jsonl');
    writeFileSync(usagePath, '');
    try {
      await expect(
        runMonitoredCommand({
          file: process.execPath,
          args: ['-e', 'process.exit(17)'],
          cwd: root,
          env: process.env,
          stage: 'test-failure-propagation',
          dest: root,
          logPath: path.join(logs, 'child.log'),
          usagePath,
          deadlineAt: Date.now() + 10_000,
          pollIntervalMs: 5,
          minimumFreeDiskGb: 0,
          minimumAvailableMemoryGb: 0,
          quiet: true,
        }),
      ).rejects.toMatchObject({
        status: 'FAIL',
        message: expect.stringContaining('exited with code 17'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GN-only validation on the standard runner', () => {
  const passing = (ids) =>
    Object.fromEntries(
      ids.map((id) => [id, { status: 'PASS', details: 'ok' }]),
    );

  it('uses fewer checkout jobs and a shorter deadline only for gn', () => {
    expect(syncJobsForMode('gn')).toBe(GN_SYNC_JOBS);
    expect(GN_SYNC_JOBS).toBe(2);
    expect(syncJobsForMode('targeted')).toBe(MAX_BUILD_JOBS);
    expect(syncJobsForMode('full')).toBe(MAX_BUILD_JOBS);
    expect(deadlineMinutesForMode('gn')).toBe(GN_DEADLINE_MINUTES);
    expect(GN_DEADLINE_MINUTES).toBeLessThan(330);
    expect(deadlineMinutesForMode('full')).toBe(330);
    expect(deadlineMinutesForMode('targeted')).toBe(330);
  });

  it('reports the four milestones as separate verdicts', () => {
    const stages = {
      'runner-preflight': { status: 'PASS', details: 'measured' },
      'pinned-sync': { status: 'PASS', details: 'pinned' },
      ...passing(GN_STAGE_IDS),
      'webui-resources': { status: 'NOT TESTED', details: 'skipped' },
    };
    expect(
      milestoneVerdicts(stages, 'gn').map((verdict) => verdict.text),
    ).toEqual([
      'PREFLIGHT PASS',
      'CHROMIUM SYNC PASS',
      'GN-ONLY PASS',
      'COMPILATION NOT TESTED',
    ]);
  });

  it('does not claim GN passed when the depot_tools bootstrap failed', () => {
    const stages = {
      ...passing(['gn-argument-policy']),
      'depot-tools-bootstrap': {
        status: 'FAIL',
        details: 'Python pointer missing',
      },
    };
    expect(milestoneVerdicts(stages, 'gn')[2]).toMatchObject({
      text: 'GN-ONLY FAIL',
      status: 'FAIL',
    });
  });

  it('never reports GN or compilation as passed when a GN stage failed', () => {
    const stages = {
      'runner-preflight': { status: 'PASS', details: 'measured' },
      'pinned-sync': { status: 'PASS', details: 'pinned' },
      ...passing(['gn-argument-policy', 'gn-generation']),
      'gn-effective-arguments': { status: 'FAIL', details: 'policy violation' },
    };
    const verdicts = milestoneVerdicts(stages, 'gn');
    expect(verdicts[2]).toMatchObject({ text: 'GN-ONLY FAIL', status: 'FAIL' });
    expect(verdicts[3].text).toBe('COMPILATION NOT TESTED');
  });

  it('distinguishes successful gn gen from failed downstream target verification', () => {
    const stages = {
      ...passing([
        'gn-argument-policy',
        'depot-tools-bootstrap',
        'gn-generation',
        'gn-effective-arguments',
      ]),
      'target-labels': {
        status: 'FAIL',
        details: 'unsupported GN field query',
      },
    };
    expect(milestoneVerdicts(stages, 'gn')[2]).toMatchObject({
      key: 'gn-only',
      text: 'GN-ONLY FAIL',
      status: 'FAIL',
      detail: expect.stringContaining('gn gen: PASS'),
    });
    expect(stages['gn-generation'].status).toBe('PASS');
  });

  it('reports a blocked preflight without implying sync or GN ran', () => {
    const verdicts = milestoneVerdicts(
      { 'runner-preflight': { status: 'BLOCKED', details: 'too small' } },
      'gn',
    );
    expect(verdicts.map((verdict) => verdict.text)).toEqual([
      'PREFLIGHT BLOCKED',
      'CHROMIUM SYNC NOT TESTED',
      'GN-ONLY NOT TESTED',
      'COMPILATION NOT TESTED',
    ]);
  });

  it('reports compilation only for the scope that actually compiled', () => {
    const stages = {
      'runner-preflight': { status: 'PASS', details: '' },
      'pinned-sync': { status: 'PASS', details: '' },
      ...passing(GN_STAGE_IDS),
      ...passing(['webui-resources', 'targeted-cpp']),
    };
    expect(milestoneVerdicts(stages, 'targeted')[3].text).toBe(
      'COMPILATION PASS',
    );
    expect(milestoneVerdicts(stages, 'full')[3].text).toBe(
      'COMPILATION NOT TESTED',
    );
  });

  it('skips every compilation stage in gn mode at the source level', () => {
    const gnSkip = DRIVER.indexOf("if (mode !== 'gn') {");
    const webui = DRIVER.indexOf("id: 'webui-resources'");
    expect(gnSkip).toBeGreaterThan(-1);
    expect(webui).toBeGreaterThan(gnSkip);
    expect(DRIVER.indexOf("id: 'targeted-cpp'")).toBeGreaterThan(gnSkip);
    expect(DRIVER.indexOf("id: 'full-chrome'")).toBeGreaterThan(gnSkip);
    expect(COMPILE_STAGE_IDS).toEqual(
      expect.arrayContaining([
        'webui-resources',
        'targeted-cpp',
        'full-chrome',
      ]),
    );
    expect(DRIVER).toMatch(
      /checkBuilder\(\{\s*dest: resolvedDest,\s*config,\s*mode,/,
    );
    expect(DRIVER).toContain('requirements: requirementsForMode(config, mode)');
  });

  it('blocks a non-GitHub gn run before any source sync and states the gn profile', async () => {
    const root = tempDirectory();
    const dest = path.join(root, 'chromium');
    const artifacts = path.join(root, 'artifacts');
    // Force the non-GitHub branch so the outcome does not depend on whether
    // this test runs on a GitHub-hosted runner (which sets these variables).
    const saved = {
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
    };
    delete process.env.GITHUB_ACTIONS;
    delete process.env.RUNNER_ENVIRONMENT;
    try {
      const result = await runValidation({
        mode: 'gn',
        runnerSize: 'standard',
        dest,
        artifacts,
        log: () => {},
        quiet: true,
        pollIntervalMs: 60_000,
      });
      expect(result.status).toBe('BLOCKED');
      const summary = readFileSync(
        path.join(artifacts, 'build-summary.md'),
        'utf8',
      );
      expect(summary).toContain('gn (GN-only, reduced)');
      expect(summary).toContain('PREFLIGHT BLOCKED');
      expect(summary).toContain('CHROMIUM SYNC NOT TESTED');
      expect(summary).toContain('COMPILATION NOT TESTED');
      expect(summary).not.toMatch(/needs 8\+/);
      expect(summary).not.toMatch(/needs 32 GB/);
      expect(summary).toContain('runner environment');
      // The source tree is never created: no sync happened.
      expect(
        readFileSync(path.join(artifacts, 'runner-capabilities.json'), 'utf8'),
      ).toContain('"validationLevel": "gn"');
      expect(() => readFileSync(path.join(dest, 'src', '.gclient'))).toThrow();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

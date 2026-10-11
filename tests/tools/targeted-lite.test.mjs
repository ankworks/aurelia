import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyBuildFailure,
  formatDuration,
  ninjaBuildArgs,
  ninjaQueryArgs,
  objectTargetFor,
  plannedObjectTargets,
  summarizeUsage,
  TARGETED_LITE_CPP_UNITS,
} from '../../tools/chromium/build-plan.mjs';
import {
  compileJobsForMode,
  deadlineMinutesForMode,
  diskReserveForMode,
  gnArgsConfigForMode,
  milestoneVerdicts,
  MINIMUM_AVAILABLE_MEMORY_GB,
  MINIMUM_DISK_RESERVE_GB,
  RESOURCE_POLL_INTERVAL_MS,
  resourceLimitReason,
  runValidation,
  syncJobsForMode,
  TARGETED_LITE_BUILD_JOBS,
  TARGETED_CPP_TARGETS,
  VALIDATION_LEVELS,
  validationScopeForMode,
  WEBUI_RESOURCE_TARGETS,
} from '../../tools/chromium/ci-validation.mjs';
import {
  evaluateResources,
  requirementsForMode,
} from '../../tools/ci/check-builder.mjs';
import { diskFloorGb, gclientSyncArgs } from '../../tools/chromium/sync.mjs';
import {
  parseGnArgsLine,
  renderGnArgs,
  validateGnArgs,
} from '../../tools/chromium/gn-args.mjs';
import { loadConfig, REPO_ROOT } from '../../tools/chromium/lib/config.mjs';

const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, '.github/workflows/chromium-build.yml'),
  'utf8',
);
const DRIVER = readFileSync(
  path.join(REPO_ROOT, 'tools/chromium/ci-validation.mjs'),
  'utf8',
);
const config = loadConfig();

const passing = (ids) =>
  Object.fromEntries(ids.map((id) => [id, { status: 'PASS', details: 'ok' }]));
const readyStages = () => ({
  'runner-preflight': { status: 'PASS', details: '' },
  'pinned-sync': { status: 'PASS', details: '' },
  ...passing([
    'gn-argument-policy',
    'depot-tools-bootstrap',
    'gn-generation',
    'gn-effective-arguments',
    'target-labels',
    'gn-check',
  ]),
});

describe('targeted-lite resource-aware compilation policy', () => {
  it('keeps the strict targeted/full gate unchanged and adds a separate experimental profile', () => {
    expect(config.buildRequirements.referenceBuilder).toMatchObject({
      cpuCores: 8,
      ramGb: 32,
      freeDiskGb: 150,
    });
    const lite = config.buildRequirements.targetedLite;
    expect(lite).toMatchObject({
      cpuCores: 4,
      ramGb: 15.5,
      freeDiskGb: 80,
      diskSafetyReserveGb: 15,
    });
    // The experimental profile is justified in the pin configuration itself.
    expect(lite.notes).toMatch(/EXPERIMENTAL targeted-lite/);
    expect(lite.notes).toMatch(/does not lower the targeted\/full/);
  });

  it('selects the targetedLite profile only for targeted-lite mode', () => {
    expect(requirementsForMode(config, 'targeted-lite')).toMatchObject({
      cpuCores: 4,
      ramGb: 15.5,
      freeDiskGb: 80,
    });
    for (const mode of ['targeted', 'full']) {
      expect(requirementsForMode(config, mode)).toMatchObject({
        cpuCores: 8,
        ramGb: 32,
        freeDiskGb: 150,
      });
    }
    expect(requirementsForMode(config, 'gn')).toMatchObject({
      cpuCores: 4,
      ramGb: 15.5,
    });
    expect(() => requirementsForMode(config, 'everything')).toThrow(
      'unknown validation mode',
    );
  });

  it('passes the measured standard runner for targeted-lite and still blocks targeted/full there', () => {
    const standard = { cpuCores: 4, ramGb: 16, bestFreeDiskGb: 147.0 };
    expect(
      evaluateResources(standard, requirementsForMode(config, 'targeted-lite')),
    ).toEqual([]);
    for (const mode of ['targeted', 'full']) {
      const problems = evaluateResources(
        standard,
        requirementsForMode(config, mode),
      );
      expect(problems.join(';')).toMatch(/logical cores: 4 \(needs 8\+\)/);
      expect(problems.join(';')).toMatch(/RAM: 16 GB \(needs 32 GB\+\)/);
    }
  });

  it('uses the mode-aware disk floors and runtime reserves without lowering the reference', () => {
    expect(diskFloorGb({ config, mode: 'targeted-lite' })).toBe(80);
    expect(diskFloorGb({ config, mode: 'targeted' })).toBe(150);
    expect(diskFloorGb({ config, mode: 'full' })).toBe(150);
    expect(diskFloorGb()).toBe(150);
    expect(diskReserveForMode('targeted-lite')).toBe(MINIMUM_DISK_RESERVE_GB);
    expect(diskReserveForMode('gn')).toBeLessThan(MINIMUM_DISK_RESERVE_GB);
  });

  it('limits compiler parallelism and checkout jobs on the 4-core profile', () => {
    expect(VALIDATION_LEVELS).toContain('targeted-lite');
    expect(TARGETED_LITE_BUILD_JOBS).toBe(2);
    expect(compileJobsForMode('targeted-lite')).toBe(2);
    expect(compileJobsForMode('targeted')).toBe(4);
    expect(compileJobsForMode('full')).toBe(4);
    expect(syncJobsForMode('targeted-lite')).toBe(2);
    expect(syncJobsForMode('targeted')).toBe(4);
    expect(deadlineMinutesForMode('targeted-lite')).toBe(330);
  });

  it('uses a shallow one-shot checkout like GN-only and never the reference floor', () => {
    const args = gclientSyncArgs({
      revision: config.chromium.revision,
      jobs: 2,
      noHistory: true,
    });
    expect(args).toContain('--no-history');
    expect(
      gclientSyncArgs({
        revision: config.chromium.revision,
        jobs: 2,
        noHistory: false,
      }),
    ).not.toContain('--no-history');
  });
});

describe('targeted-lite build command construction', () => {
  it('builds exact autoninja commands with the mode job cap', () => {
    expect(
      ninjaBuildArgs({
        outDirRelative: 'out/Aurelia',
        jobs: 2,
        targets: ['//chrome/browser/resources/aurelia:build_ts'],
      }),
    ).toEqual([
      '-C',
      'out/Aurelia',
      '-j',
      '2',
      '//chrome/browser/resources/aurelia:build_ts',
    ]);
    expect(
      ninjaQueryArgs({
        outDirRelative: 'out/Aurelia',
        target: 'obj/chrome/browser/ui/webui/aurelia/aurelia/aurelia_ui.obj',
      }),
    ).toEqual([
      '-C',
      'out/Aurelia',
      '-t',
      'query',
      'obj/chrome/browser/ui/webui/aurelia/aurelia/aurelia_ui.obj',
    ]);
  });

  it('refuses to plan a build without concrete targets or a job count', () => {
    expect(() =>
      ninjaBuildArgs({
        outDirRelative: 'out/Aurelia',
        jobs: 0,
        targets: ['x'],
      }),
    ).toThrow('invalid ninja build plan');
    expect(() =>
      ninjaBuildArgs({ outDirRelative: 'out/Aurelia', jobs: 2, targets: [] }),
    ).toThrow('at least one concrete target');
    expect(() => ninjaQueryArgs({ outDirRelative: 'out', target: '' })).toThrow(
      'concrete target',
    );
  });

  it('plans the WebUI resource targets before the C++ translation units', () => {
    const execution = DRIVER.slice(
      DRIVER.indexOf('const gnArgsFile'),
      DRIVER.indexOf("writeSummary(context, 'PASS')"),
    );
    expect(execution.indexOf("id: 'webui-resources'")).toBeGreaterThan(-1);
    expect(execution.indexOf("if (mode === 'targeted-lite')")).toBeGreaterThan(
      execution.indexOf("id: 'webui-resources'"),
    );
    expect(execution.indexOf('runTargetedLiteCppStage')).toBeGreaterThan(
      execution.indexOf("if (mode === 'targeted-lite')"),
    );
    // The strict source_set build stays behind its own mode guard.
    expect(
      execution.indexOf("if (mode === 'targeted' || mode === 'full')"),
    ).toBeGreaterThan(execution.indexOf('runTargetedLiteCppStage'));
    // Object-target existence is queried with plain ninja tool mode (works for
    // both ninja and Siso backends); the compile itself uses autoninja.
    expect(DRIVER).toMatch(/logCapture\(\s*'ninja',/);
  });
});

describe('targeted-lite target selection', () => {
  it('derives exact Ninja object targets from the GN source_set labels', () => {
    expect(
      objectTargetFor(
        '//chrome/browser/ui/webui/aurelia:aurelia',
        'chrome/browser/ui/webui/aurelia/aurelia_ui.cc',
      ),
    ).toBe('obj/chrome/browser/ui/webui/aurelia/aurelia/aurelia_ui.obj');
    expect(
      objectTargetFor(
        '//chrome/browser/ui/webui/newtab:newtab',
        'chrome/browser/ui/webui/newtab/newtab_ui.cc',
      ),
    ).toBe('obj/chrome/browser/ui/webui/newtab/newtab/newtab_ui.obj');
    expect(() => objectTargetFor('//a/b:name', 'elsewhere/x.cc')).toThrow(
      'not under the BUILD directory',
    );
    expect(() => objectTargetFor('not-a-label', 'a/b/x.cc')).toThrow(
      'invalid GN target label',
    );
    expect(() => objectTargetFor('//a/b:name', 'a/b/readme.md')).toThrow(
      'not a compilable',
    );
    expect(() => objectTargetFor('//a/b:name', 'a/b/../c/x.cc')).toThrow(
      'stable Ninja object target',
    );
  });

  it('matches the translation units declared in the overlay BUILD.gn files', () => {
    for (const unit of TARGETED_LITE_CPP_UNITS) {
      const dir = unit.gnLabel.slice(2).split(':')[0];
      const buildGn = readFileSync(
        path.join(REPO_ROOT, 'chromium/overlay', dir, 'BUILD.gn'),
        'utf8',
      );
      const declared = [...buildGn.matchAll(/"([^"]+\.cc)"/g)].map(
        (match) => match[1],
      );
      expect(declared).toContain(unit.source.slice(dir.length + 1));
      expect(unit.object).toBe(objectTargetFor(unit.gnLabel, unit.source));
    }
    expect(TARGETED_LITE_CPP_UNITS).toHaveLength(2);
    expect(() => plannedObjectTargets(TARGETED_LITE_CPP_UNITS)).not.toThrow();
    expect(() =>
      plannedObjectTargets([
        {
          gnLabel: '//x:y',
          source: 'x/y.cc',
          object: 'obj/x/y/wrong.obj',
        },
      ]),
    ).toThrow('does not match the derived target');
  });

  it('keeps the reviewed resource and C++ source_set labels for every mode', () => {
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
  });
});

describe('targeted-lite GN configuration policy', () => {
  it('selects the reviewed targeted-lite argument file only for that mode', () => {
    expect(gnArgsConfigForMode('targeted-lite')).toBe(
      'config/gn/win-x64-targeted-lite.gn',
    );
    for (const mode of ['gn', 'targeted', 'full']) {
      expect(gnArgsConfigForMode(mode)).toBe('config/gn/win-x64-dev.gn');
    }
  });

  it('keeps the targeted-lite arguments inside the reviewed allowlist', () => {
    const text = readFileSync(
      path.join(REPO_ROOT, 'config/gn/win-x64-targeted-lite.gn'),
      'utf8',
    );
    const { entries, problems } = validateGnArgs(text);
    expect(problems).toEqual([]);
    const byKey = Object.fromEntries(
      entries.map((entry) => [entry.key, entry.value]),
    );
    expect(byKey.symbol_level).toBe('0');
    expect(byKey.is_debug).toBe('false');
    expect(byKey.target_cpu).toBe('"x64"');
    // Verified supported at the pin but deliberately not set: the targeted-lite
    // scope compiles no Blink or V8 objects.
    expect(byKey).not.toHaveProperty('blink_symbol_level');
    expect(byKey).not.toHaveProperty('v8_symbol_level');
    const rendered = renderGnArgs(entries);
    expect(parseGnArgsLine(rendered).problems).toEqual([]);
  });
});

describe('targeted-lite memory and disk safeguards', () => {
  it('stops safely on measured disk or memory exhaustion', () => {
    expect(
      resourceLimitReason(
        { freeDiskGb: 14, availableMemoryGb: 8 },
        { minimumFreeDiskGb: diskReserveForMode('targeted-lite') },
      ),
    ).toContain('RESOURCE EXHAUSTED');
    expect(
      resourceLimitReason(
        { freeDiskGb: 100, availableMemoryGb: 1 },
        { minimumFreeDiskGb: diskReserveForMode('targeted-lite') },
      ),
    ).toContain('available memory');
    expect(
      resourceLimitReason(
        { freeDiskGb: 100, availableMemoryGb: 8 },
        { minimumFreeDiskGb: diskReserveForMode('targeted-lite') },
      ),
    ).toBeNull();
    expect(MINIMUM_AVAILABLE_MEMORY_GB).toBeGreaterThan(0);
    expect(RESOURCE_POLL_INTERVAL_MS).toBe(30_000);
  });

  it('summarises measured peaks without inventing numbers', () => {
    expect(summarizeUsage([])).toBeNull();
    expect(summarizeUsage(undefined)).toBeNull();
    expect(
      summarizeUsage([
        { totalMemoryGb: 16, availableMemoryGb: 4, freeDiskGb: 90 },
        { totalMemoryGb: 16, availableMemoryGb: 2.5, freeDiskGb: 88.5 },
        { totalMemoryGb: 16, availableMemoryGb: 6, freeDiskGb: 91 },
      ]),
    ).toEqual({
      sampleCount: 3,
      peakUsedMemoryGb: 13.5,
      minimumAvailableMemoryGb: 2.5,
      minimumFreeDiskGb: 88.5,
    });
  });

  it('formats durations for the stage table', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(123_000)).toBe('2m 3s');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(undefined)).toBe('unknown');
  });
});

describe('targeted-lite compilation result reporting', () => {
  it('classifies resource exhaustion separately from source compilation errors', () => {
    expect(
      classifyBuildFailure('fatal error C1060: compiler is out of heap space'),
    ).toBe('memory-exhaustion');
    expect(
      classifyBuildFailure('LINK : fatal error LNK1102: out of memory'),
    ).toBe('memory-exhaustion');
    expect(classifyBuildFailure('There is not enough space on the disk.')).toBe(
      'disk-exhaustion',
    );
    expect(
      classifyBuildFailure(
        "aurelia_ui.cc(10): fatal error C1083: Cannot open include file: 'missing.h'",
      ),
    ).toBe('missing-include');
    expect(
      classifyBuildFailure(
        "ninja: error: 'obj/x.obj', needed by 'y', missing and no known rule to make it",
      ),
    ).toBe('target-resolution');
    expect(
      classifyBuildFailure(
        "aurelia_ui.cc(12): error C2065: 'x': undeclared identifier",
      ),
    ).toBe('compiler-error');
    expect(classifyBuildFailure('something else entirely')).toBe(
      'unclassified',
    );
  });

  it('reports WEBUI RESOURCES and AURELIA C++ as separate milestones', () => {
    const stages = {
      ...readyStages(),
      ...passing(['webui-resources']),
      'targeted-cpp': { status: 'NOT TESTED', details: 'Not reached.' },
    };
    const verdicts = milestoneVerdicts(stages, 'targeted-lite');
    expect(verdicts.map((verdict) => verdict.text)).toEqual([
      'PREFLIGHT PASS',
      'CHROMIUM SYNC PASS',
      'GN-ONLY PASS',
      'WEBUI RESOURCES PASS',
      'AURELIA C++ NOT TESTED',
    ]);
    // A resource PASS is never presented as a C++ or browser compile PASS.
    expect(verdicts[3].detail).toMatch(/pak packaging/);
    expect(verdicts[4].detail).toMatch(/NOT TESTED in targeted-lite/);
  });

  it('never reports COMPILATION for targeted-lite and keeps gn at four milestones', () => {
    const allPass = {
      ...readyStages(),
      ...passing(['webui-resources', 'targeted-cpp']),
    };
    const lite = milestoneVerdicts(allPass, 'targeted-lite');
    expect(lite).toHaveLength(5);
    expect(lite.map((verdict) => verdict.text)).toEqual([
      'PREFLIGHT PASS',
      'CHROMIUM SYNC PASS',
      'GN-ONLY PASS',
      'WEBUI RESOURCES PASS',
      'AURELIA C++ PASS',
    ]);
    expect(lite.some((verdict) => /COMPILATION/.test(verdict.text))).toBe(
      false,
    );
    const gn = milestoneVerdicts(allPass, 'gn');
    expect(gn).toHaveLength(4);
    expect(gn[3].text).toBe('COMPILATION NOT TESTED');
  });

  it('propagates FAIL and RESOURCE EXHAUSTED without downgrading them', () => {
    const failed = {
      ...readyStages(),
      'webui-resources': { status: 'FAIL', details: 'tsc error' },
      'targeted-cpp': { status: 'NOT TESTED', details: 'Not reached.' },
    };
    expect(
      milestoneVerdicts(failed, 'targeted-lite').map((v) => v.text),
    ).toEqual([
      'PREFLIGHT PASS',
      'CHROMIUM SYNC PASS',
      'GN-ONLY PASS',
      'WEBUI RESOURCES FAIL',
      'AURELIA C++ NOT TESTED',
    ]);
    const exhausted = {
      ...readyStages(),
      ...passing(['webui-resources']),
      'targeted-cpp': { status: 'RESOURCE EXHAUSTED', details: 'deadline' },
    };
    expect(milestoneVerdicts(exhausted, 'targeted-lite')[4]).toMatchObject({
      text: 'AURELIA C++ RESOURCE EXHAUSTED',
      status: 'RESOURCE EXHAUSTED',
    });
  });

  it('states the limited targeted-lite scope explicitly and claims no browser build', () => {
    const liteScope = validationScopeForMode('targeted-lite');
    expect(liteScope).toMatch(/EXPERIMENTAL, deliberately limited scope/);
    expect(liteScope).toMatch(/object-level/);
    expect(liteScope).toMatch(
      /chrome target and runtime validation are NOT TESTED/,
    );
    expect(validationScopeForMode('gn')).toMatch(/Compilation is NOT TESTED/);
    expect(validationScopeForMode('targeted')).toMatch(/source_set targets/);
    expect(validationScopeForMode('full')).toMatch(
      /Runtime validation is NOT TESTED/,
    );
  });

  it('exposes targeted-lite as a manual dispatch option with a limited-scope description', () => {
    expect(WORKFLOW).toContain('workflow_dispatch:');
    expect(WORKFLOW).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(WORKFLOW).toMatch(
      /options:\s*\n\s+- gn\n\s+- targeted-lite\n\s+- targeted\n\s+- full/,
    );
    expect(WORKFLOW).toContain('experimental resource-aware level');
    expect(WORKFLOW).toContain('never links, never builds chrome');
  });
});

describe('targeted-lite run-level blocking before source sync', () => {
  it('reports BLOCKED on a non-GitHub environment before any Chromium sync', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aurelia-targeted-lite-'));
    const dest = path.join(root, 'chromium');
    const artifacts = path.join(root, 'artifacts');
    const saved = {
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT,
    };
    delete process.env.GITHUB_ACTIONS;
    delete process.env.RUNNER_ENVIRONMENT;
    try {
      const result = await runValidation({
        mode: 'targeted-lite',
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
      expect(summary).toContain('targeted-lite (experimental reduced profile)');
      expect(summary).toContain('PREFLIGHT BLOCKED');
      expect(summary).toContain('CHROMIUM SYNC NOT TESTED');
      expect(summary).toContain('WEBUI RESOURCES NOT TESTED');
      expect(summary).toContain('AURELIA C++ NOT TESTED');
      expect(summary).toMatch(/EXPERIMENTAL, deliberately limited scope/);
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

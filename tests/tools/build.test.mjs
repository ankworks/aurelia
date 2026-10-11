import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BUILD_STAGES,
  LADDER,
  REPO_ROOT,
  buildPlan,
  runBuild,
} from '../../tools/chromium/build.mjs';

describe('legacy build-plan tooling', () => {
  const plan = buildPlan({ dest: 'D:/chromium' });

  it('retires the legacy executor and requires the unified workflow', () => {
    expect(() => runBuild()).toThrow(
      'The legacy build executor is retired. Dispatch .github/workflows/chromium-build.yml',
    );
  });

  it('runs the pipeline in the order that earns the ladder states', () => {
    expect(plan.map((stage) => stage.id)).toEqual([
      'preflight',
      'sync',
      'verify-patches',
      'install-overlay',
      'fork-delta',
      'gn-args',
      'gn-gen',
      'compile',
      'stage',
      'smoke-test',
      'record',
      'package',
    ]);
  });

  it('verifies the patch set before writing anything into the checkout', () => {
    const verify = plan.findIndex((stage) => stage.id === 'verify-patches');
    const install = plan.findIndex((stage) => stage.id === 'install-overlay');
    expect(verify).toBeLessThan(install);
  });

  it('never weakens the browser to make a build pass', () => {
    const allArgs = plan
      .flatMap((stage) => stage.commands)
      .flatMap((command) => command.args)
      .join(' ');
    expect(allArgs).not.toContain('--no-sandbox');
    expect(allArgs).not.toContain('--allow-disabled-sandbox');
    expect(allArgs).not.toContain('disable_site_isolation');
    expect(allArgs).not.toContain('disable_web_security');
  });

  it('stages and smoke tests the packaged directory, not the raw build output', () => {
    const smoke = plan
      .find((stage) => stage.id === 'smoke-test')
      .commands.flatMap((command) => command.args)
      .join(' ');
    expect(smoke).toContain('artifacts');
    expect(smoke).toContain('staged');
    // The record step must read the same report the smoke test wrote.
    const record = plan
      .find((stage) => stage.id === 'record')
      .commands.flatMap((command) => command.args)
      .join(' ');
    const reportFile = smoke.split('--report ')[1];
    expect(record).toContain(reportFile);
  });

  it('records the effective arguments from the build, not the reviewed file', () => {
    const stage = plan
      .find((s) => s.id === 'stage')
      .commands.flatMap((command) => command.args)
      .join(' ');
    expect(stage).toContain(path.join('out', 'Release', 'args.gn'));
  });

  it('skips only the sync stage with --skip-sync', () => {
    const skipped = buildPlan({ dest: 'D:/chromium', skipSync: true });
    expect(skipped.map((stage) => stage.id)).not.toContain('sync');
    expect(skipped.map((stage) => stage.id)).toContain('verify-patches');
  });

  it('keeps the hosted validation stages ordered and explicit', () => {
    const driver = readFileSync(
      path.join(REPO_ROOT, 'tools/chromium/ci-validation.mjs'),
      'utf8',
    );
    const markers = [
      "id: 'pinned-sync'",
      "id: 'patch-verification'",
      "id: 'overlay-application'",
      "id: 'fork-delta'",
      "id: 'gn-argument-policy'",
      "id: 'gn-generation'",
      "id: 'gn-effective-arguments'",
      "setStage(context, 'gn-check', 'RUNNING'",
      "id: 'webui-resources'",
      "id: 'targeted-cpp'",
      "id: 'full-chrome'",
    ];
    let cursor = -1;
    for (const marker of markers) {
      const index = driver.indexOf(marker, cursor + 1);
      expect(
        index,
        `validation driver is missing stage: ${marker}`,
      ).toBeGreaterThan(-1);
      expect(index, `validation stage out of order: ${marker}`).toBeGreaterThan(
        cursor,
      );
      cursor = index;
    }
    expect(BUILD_STAGES.length).toBeGreaterThanOrEqual(markers.length);
  });

  it('keeps the retired low-resource dry-run behind the full sync disk gate', () => {
    const low = buildPlan({
      dest: 'D:/chromium',
      profile: 'low-resource',
      jobs: 2,
    });
    const commands = low.flatMap((stage) => stage.commands);
    const gnArgs = commands.find((command) =>
      command.args.some((argument) =>
        argument.endsWith('win-x64-low-resource.gn'),
      ),
    );
    expect(gnArgs).toBeDefined();
    const preflight = commands.find((command) =>
      command.args.includes('--check-only'),
    );
    expect(preflight.args).not.toContain('--low-resource-experiment');
    const sync = commands.find(
      (command) =>
        command.args.some((argument) => argument.endsWith('sync.mjs')) &&
        !command.args.includes('--check-only'),
    );
    expect(sync.args).not.toContain('--low-resource-experiment');
    const compile = commands.find((command) => command.file === 'autoninja');
    expect(compile.args).toContain('-j');
    expect(compile.args).toContain('2');
  });

  it('keeps the retired low-resource plan bounded to one job by default', () => {
    const low = buildPlan({ dest: 'D:/chromium', profile: 'low-resource' });
    const compile = low
      .flatMap((stage) => stage.commands)
      .find((command) => command.file === 'autoninja');
    expect(compile.args).toEqual(['-C', 'out/Release', '-j', '1', 'chrome']);
  });

  it('leaves ninja unbounded only in the documented dev profile', () => {
    const dev = buildPlan({ dest: 'D:/chromium' });
    const compile = dev
      .flatMap((stage) => stage.commands)
      .find((command) => command.file === 'autoninja');
    expect(compile.args).toEqual(['-C', 'out/Release', 'chrome']);
  });

  it('supports resuming a single stage or a subset', () => {
    const only = buildPlan({
      dest: 'D:/chromium',
      only: ['sync', 'compile', 'package'],
    });
    expect(only.map((stage) => stage.id)).toEqual([
      'sync',
      'compile',
      'package',
    ]);
    const smoke = buildPlan({ dest: 'D:/chromium', only: ['smoke-test'] });
    expect(smoke.map((stage) => stage.id)).toEqual(['smoke-test']);
  });

  it('refuses unknown profiles and unknown stage names instead of guessing', () => {
    expect(() =>
      buildPlan({ dest: 'D:/chromium', profile: 'official' }),
    ).toThrow(/unknown profile/);
    expect(() =>
      buildPlan({ dest: 'D:/chromium', only: ['sync', 'everything'] }),
    ).toThrow(/unknown stage/);
  });

  it('names a log file for every stage that can be resumed', () => {
    const plan = buildPlan({ dest: 'D:/chromium' });
    for (const stage of plan) {
      for (const command of stage.commands) {
        expect(typeof command.logName).toBe('string');
        expect(command.logName.endsWith('.log')).toBe(true);
      }
    }
    const gnGen = plan.find((stage) => stage.id === 'gn-gen');
    expect(gnGen.commands.some((command) => command.logName === 'gn.log')).toBe(
      true,
    );
  });

  it('states the ladder without collapsing any step', () => {
    expect(LADDER.map(([, state]) => state)).toEqual([
      'INTEGRATION SOURCE VERIFIED',
      'CONFIGURATION VERIFIED',
      'COMPILED',
      'RUNTIME INTEGRATED',
      'TESTED',
      'VERIFIED (run by a human)',
    ]);
  });
});

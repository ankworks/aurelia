#!/usr/bin/env node
/**
 * Manual GitHub-hosted Chromium validation pipeline.
 *
 * This driver deliberately reuses Aurelia's pinned checkout, patch verification,
 * overlay installation, GN policy, runtime staging, and packaging tools. It does
 * not contain a second Chromium preparation implementation.
 *
 * Usage:
 *   node tools/chromium/ci-validation.mjs \
 *     --mode gn|targeted|full --runner-size standard|larger \
 *     --dest <runner-temp>/aurelia-chromium --artifacts <workspace>/artifacts
 *
 * A standard GitHub-hosted runner is measured and blocked before any Chromium
 * source is fetched when it does not meet the repository's builder minimums.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import path from 'node:path';

import {
  checkBuilder,
  freeDiskGb,
  requirementsForMode,
} from '../ci/check-builder.mjs';
import { isGithubHostedRunner } from '../ci/runner-environment.mjs';
import { isMainModule } from '../lib/entry.mjs';
import { captureCommand, resolveSpawn, withPathPrefix } from './lib/exec.mjs';
import { describeGitEnvironment } from './lib/windows-git.mjs';
import { scopedGnCheckCommands, verifyGnTargets } from './gn-targets.mjs';
import {
  isSdkVersionCompatible,
  REQUIRED_SDK_VERSION,
} from './lib/windows-toolchain.mjs';
import { loadConfig, REPO_ROOT } from './lib/config.mjs';
import {
  MINIMUM_PRE_SYNC_FREE_DISK_GB,
  prepareHostedWindowsRunner,
} from './prepare-runner.mjs';
import { planStaging } from './stage-runtime.mjs';

export const VALIDATION_LEVELS = Object.freeze(['gn', 'targeted', 'full']);
export const RUNNER_SIZES = Object.freeze(['standard', 'larger']);
export const MAX_BUILD_JOBS = 4;
export const RESOURCE_POLL_INTERVAL_MS = 30_000;
export const INTERNAL_DEADLINE_MINUTES = 330;
/**
 * GN-only validation never compiles, so it gets a shorter internal deadline
 * (checkout plus gn gen/check) and fewer checkout jobs on the 4-core runner.
 */
export const GN_DEADLINE_MINUTES = 240;
export const GN_SYNC_JOBS = 2;
/**
 * Runtime disk reserve (GB) that must remain FREE at all times during the run.
 * GN-only uses a smaller reserve (10 GB) because it produces no build artifacts;
 * compilation modes keep the 15 GB reserve for object files, PDBs, and temp space.
 */
export const MINIMUM_DISK_RESERVE_GB_GN = 10;
export const MINIMUM_DISK_RESERVE_GB = 15;
export const MINIMUM_AVAILABLE_MEMORY_GB = 1.5;
export const MAX_BROWSER_ARTIFACT_BYTES = 450 * 1024 ** 2;

/**
 * Return the runtime free-disk reserve for a validation mode.
 * @param {string} mode
 * @returns {number}
 */
export function diskReserveForMode(mode) {
  return mode === 'gn' ? MINIMUM_DISK_RESERVE_GB_GN : MINIMUM_DISK_RESERVE_GB;
}

/**
 * These labels come from Aurelia's overlay BUILD.gn files and Chromium's
 * build_webui() template at the configured pin. build_ts compiles TypeScript,
 * build_grd assembles resources.grd, and resources runs GRIT and emits the pak.
 */
export const WEBUI_RESOURCE_TARGETS = Object.freeze([
  '//chrome/browser/resources/aurelia:build_ts',
  '//chrome/browser/resources/aurelia:build_grd',
  '//chrome/browser/resources/aurelia:resources',
  '//chrome/browser/resources/newtab:build_ts',
  '//chrome/browser/resources/newtab:build_grd',
  '//chrome/browser/resources/newtab:resources',
]);

/** Stages that compile code. gn mode skips every one of them. */
export const COMPILE_STAGE_IDS = Object.freeze([
  'webui-resources',
  'targeted-cpp',
  'full-chrome',
  'browser-staging',
  'browser-packaging',
  'browser-artifact',
]);

/** Stages that prove GN configuration without compiling anything. */
export const GN_STAGE_IDS = Object.freeze([
  'gn-argument-policy',
  'depot-tools-bootstrap',
  'gn-generation',
  'gn-effective-arguments',
  'target-labels',
  'gn-check',
]);

/** Checkout/sync jobs for a mode: fewer on the GN-only profile. */
export function syncJobsForMode(mode) {
  return mode === 'gn' ? GN_SYNC_JOBS : MAX_BUILD_JOBS;
}

/** Internal wall-clock deadline for a mode, always below the 360-minute job timeout. */
export function deadlineMinutesForMode(mode) {
  return mode === 'gn' ? GN_DEADLINE_MINUTES : INTERNAL_DEADLINE_MINUTES;
}

function combinedStatus(stages, ids) {
  const statuses = ids.map((id) => stages[id]?.status ?? 'NOT TESTED');
  if (statuses.every((status) => status === 'PASS')) {
    return 'PASS';
  }
  return statuses.find((status) => status !== 'PASS' && status !== 'NOT TESTED') ?? 'NOT TESTED';
}

/**
 * The four user-facing milestones, kept separate on purpose: a GN pass must
 * never be reported as a compilation pass.
 */
export function milestoneVerdicts(stages, mode) {
  const preflight = stages['runner-preflight']?.status ?? 'NOT TESTED';
  const sync = stages['pinned-sync']?.status ?? 'NOT TESTED';
  const gn = combinedStatus(stages, GN_STAGE_IDS);
  let compilation;
  let compilationDetail;
  if (mode === 'gn') {
    compilation = 'NOT TESTED';
    compilationDetail =
      'gn validation does not compile. WebUI resources, targeted C++, and full chrome were not built.';
  } else if (mode === 'targeted') {
    compilation = combinedStatus(stages, ['targeted-cpp']);
    compilationDetail =
      'Scope: the two Aurelia C++ source_set targets only. Full chrome was not built.';
  } else {
    compilation = combinedStatus(stages, ['targeted-cpp', 'full-chrome']);
    compilationDetail =
      'Scope: the Aurelia C++ targets and the full chrome target, both in this run.';
  }
  const text = (label, status) =>
    status === 'PASS' ? `${label} PASS` : `${label} ${status}`;
  return [
    {
      key: 'preflight',
      text: text('PREFLIGHT', preflight),
      status: preflight,
      detail: stages['runner-preflight']?.details ?? 'Not reached.',
    },
    {
      key: 'chromium-sync',
      text: text('CHROMIUM SYNC', sync),
      status: sync,
      detail: stages['pinned-sync']?.details ?? 'Not reached.',
    },
    {
      key: 'gn-gen',
      text: text('GN GEN', gn),
      status: gn,
      detail: 'GN policy, pinned depot_tools bootstrap, gn gen, effective arguments, target labels, and gn check.',
    },
    {
      key: 'compilation',
      text: text('COMPILATION', compilation),
      status: compilation,
      detail: compilationDetail,
    },
  ];
}

/** C++ source_set labels declared in the Aurelia overlay BUILD.gn files. */
export const TARGETED_CPP_TARGETS = Object.freeze([
  '//chrome/browser/ui/webui/aurelia:aurelia',
  '//chrome/browser/ui/webui/newtab:newtab',
]);

export const TARGETED_BUILD_TARGETS = Object.freeze([
  ...WEBUI_RESOURCE_TARGETS,
  ...TARGETED_CPP_TARGETS,
]);

/** Outputs expected from the pinned build_webui() and GRIT target graph. */
export const WEBUI_RESOURCE_OUTPUTS = Object.freeze([
  'gen/chrome/browser/resources/aurelia/resources.grd',
  'gen/chrome/browser/resources/aurelia/tsc/aurelia_app.js',
  'gen/chrome/browser/resources/aurelia/tsc/aurelia_status_card.js',
  'gen/chrome/browser/resources/aurelia/tsc/command_palette.js',
  'gen/chrome/grit/aurelia_resources.h',
  'gen/chrome/grit/aurelia_resources_map.h',
  'gen/chrome/aurelia_resources.pak',
  'gen/chrome/browser/resources/newtab/resources.grd',
  'gen/chrome/browser/resources/newtab/tsc/newtab_app.js',
  'gen/chrome/grit/aurelia_newtab_resources.h',
  'gen/chrome/grit/aurelia_newtab_resources_map.h',
  'gen/chrome/aurelia_newtab_resources.pak',
]);

const STAGES = Object.freeze([
  ['runner-preflight', 'GitHub-hosted runner capability preflight'],
  ['pinned-sync', 'Pinned depot_tools and Chromium checkout'],
  ['patch-verification', 'Patch verification against the pristine pin'],
  ['overlay-application', 'Aurelia overlay and patch application'],
  ['fork-delta', 'Reviewed fork-delta budget'],
  ['gn-argument-policy', 'Reviewed GN argument validation'],
  ['gn-generation', 'GN generation'],
  ['gn-effective-arguments', 'Effective generated GN argument verification'],
  ['target-labels', 'Pinned GN target-label verification'],
  ['gn-check', 'Scoped GN dependency check'],
  ['webui-resources', 'WebUI TypeScript, GRIT, and pak generation'],
  ['targeted-cpp', 'Targeted Aurelia C++ compilation'],
  ['full-chrome', 'Full Chromium chrome target compilation'],
  ['browser-staging', 'Optional full-build runtime staging'],
  ['browser-packaging', 'Optional bounded browser packaging'],
  ['browser-artifact', 'Optional full-build browser artifact'],
]);

export class ValidationError extends Error {
  constructor(message, status = 'FAIL') {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/** Validate and normalize command-line options before starting any work. */
export function parseValidationOptions(argv, env = process.env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--mode', '--runner-size', '--dest', '--artifacts'].includes(flag)) {
      throw new ValidationError(`unknown option: ${flag}`, 'FAIL');
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ValidationError(`${flag} requires a value`, 'FAIL');
    }
    values[flag] = value;
    index += 1;
  }

  const mode = values['--mode'] ?? env.AURELIA_VALIDATION_LEVEL ?? 'gn';
  const runnerSize =
    values['--runner-size'] ?? env.AURELIA_RUNNER_SIZE ?? 'standard';
  if (!VALIDATION_LEVELS.includes(mode)) {
    throw new ValidationError(
      `invalid validation level "${mode}"; choose ${VALIDATION_LEVELS.join(', ')}`,
      'FAIL',
    );
  }
  if (!RUNNER_SIZES.includes(runnerSize)) {
    throw new ValidationError(
      `invalid runner size "${runnerSize}"; choose ${RUNNER_SIZES.join(', ')}`,
      'FAIL',
    );
  }

  const dest = values['--dest'] ?? env.AURELIA_CHROMIUM_DEST;
  const artifacts = values['--artifacts'] ?? env.AURELIA_ARTIFACTS_DIR;
  if (!dest) {
    throw new ValidationError('--dest <directory> is required', 'FAIL');
  }
  if (!artifacts) {
    throw new ValidationError('--artifacts <directory> is required', 'FAIL');
  }

  return {
    mode,
    runnerSize,
    dest: path.resolve(dest),
    artifacts: path.resolve(artifacts),
  };
}

/** Refuse to continue if the Chromium checkout is not exactly the configured pin. */
export function assertPinnedRevision(expected, actual, name = 'Chromium') {
  if (!/^[0-9a-f]{40}$/.test(expected ?? '')) {
    throw new ValidationError(`${name} pin is not a full 40-character SHA`, 'FAIL');
  }
  if (actual !== expected) {
    throw new ValidationError(
      `${name} checkout is ${actual || 'unknown'}; expected ${expected}; refusing to continue`,
      'FAIL',
    );
  }
  return actual;
}

/** Check measured resources and preserve the reserve required by the build. */
export { isGithubHostedRunner };

export function resourceLimitReason(sample, {
  minimumFreeDiskGb = MINIMUM_DISK_RESERVE_GB,
  minimumAvailableMemoryGb = MINIMUM_AVAILABLE_MEMORY_GB,
} = {}) {
  if (
    typeof sample.freeDiskGb !== 'number' ||
    !Number.isFinite(sample.freeDiskGb)
  ) {
    return 'RESOURCE EXHAUSTED: free disk could not be measured; stopping rather than continue without the disk reserve';
  }
  if (sample.freeDiskGb < minimumFreeDiskGb) {
    return `RESOURCE EXHAUSTED: free disk fell to ${sample.freeDiskGb.toFixed(1)} GB (reserve is ${minimumFreeDiskGb} GB)`;
  }
  if (
    typeof sample.availableMemoryGb !== 'number' ||
    !Number.isFinite(sample.availableMemoryGb)
  ) {
    return 'RESOURCE EXHAUSTED: available memory could not be measured; stopping rather than continue without the memory reserve';
  }
  if (sample.availableMemoryGb < minimumAvailableMemoryGb) {
    return `RESOURCE EXHAUSTED: available memory fell to ${sample.availableMemoryGb.toFixed(1)} GB (reserve is ${minimumAvailableMemoryGb} GB)`;
  }
  return null;
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatGb(value) {
  return typeof value === 'number' ? `${value.toFixed(1)} GB` : 'unknown';
}

function makeSummary({
  overall,
  mode,
  runnerSize,
  aureliaRevision,
  config,
  capabilities,
  requirements,
  stages,
  failure,
  artifact,
}) {
  const runUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : 'not running in GitHub Actions';
  const actualFree = capabilities?.destinationFreeDiskGb;
  const stageRows = STAGES.map(([id, label]) => {
    const result = stages[id] ?? { status: 'NOT TESTED', details: 'Not reached.' };
    return `| ${markdownCell(label)} | **${markdownCell(result.status)}** | ${markdownCell(result.details)} |`;
  });
  const lines = [
    '# Chromium build validation summary',
    '',
    `- Overall status: **${overall}**`,
    `- Validation level: \`${mode}\``,
    `- Requested GitHub-hosted runner: \`${runnerSize}\``,
    `- Resource profile: \`${mode === 'gn' ? 'gn (GN-only, reduced)' : `${mode} (strict reference builder)`}\``,
    `- Aurelia revision: \`${aureliaRevision ?? 'unknown'}\``,
    `- Chromium version: \`${config?.chromium?.version ?? 'unknown'}\``,
    `- Chromium pinned revision: \`${config?.chromium?.revision ?? 'unknown'}\``,
    `- depot_tools pinned revision: \`${config?.toolchain?.depotTools?.revision ?? 'unknown'}\``,
    `- Workflow run: ${runUrl}`,
    '',
    '## Measured runner resources',
    '',
    '| Resource | Measured | Minimum for this mode |',
    '| --- | ---: | ---: |',
    `| Logical CPU cores | ${capabilities?.cpuCores ?? 'unknown'} | ${requirements?.cpuCores ?? 'unknown'} |`,
    `| RAM | ${formatGb(capabilities?.ramGb)} | ${requirements?.ramGb ?? 'unknown'} GB |`,
    `| Free disk on Chromium destination volume | ${formatGb(actualFree)} | ${requirements?.freeDiskGb ?? 'unknown'} GB |`,
    `| Runner environment | ${capabilities?.runnerEnvironment ?? 'unknown'} | GitHub-hosted |`,
    `| Architecture / OS | ${capabilities?.architecture ?? 'unknown'} / ${capabilities?.platform ?? 'unknown'} | Windows x64 |`,
    `| Windows SDK | ${capabilities?.windowsSdk ?? 'unknown'} | ${REQUIRED_SDK_VERSION}+ |`,
    '',
    ...(capabilities?.preparation
      ? [
          '## Runner preparation (pre-sync)',
          '',
          `- Free disk before cleanup: \`${formatGb(capabilities.preparation.before?.freeDiskGb)}\``,
          `- Free disk after preparation: \`${formatGb(capabilities.preparation.after?.freeDiskGb)}\` (measured reclaimed \`${formatGb(capabilities.preparation.cleanup?.reclaimedGb ?? 0)}\`)`,
          `- Cleanup accounting: \`${capabilities.preparation.cleanup?.removedTargets?.length ?? 0}\` removed, \`${capabilities.preparation.cleanup?.offVolumeTargets?.length ?? 0}\` on another volume, \`${capabilities.preparation.cleanup?.missingTargets?.length ?? 0}\` absent, \`${capabilities.preparation.cleanup?.failedTargets?.length ?? 0}\` failed`,
          `- Windows SDK before preparation: \`${capabilities.preparation.before?.windowsSdk ?? 'none'}\``,
          `- Windows SDK after preparation: \`${capabilities.preparation.after?.windowsSdk ?? 'none'}\` (installed=${capabilities.preparation.sdkProvisioning?.installed ?? false})`,
          `- Visual Studio / MSVC intact: \`${capabilities.preparation.after?.visualStudioIntact ?? false}\``,
          ...(Array.isArray(capabilities.preparation.volumes?.volumes) &&
          capabilities.preparation.volumes.volumes.length > 0
            ? [
                '',
                '### Storage volumes measured on the runner',
                '',
                `| Volume | Free disk | Meets ${requirements?.freeDiskGb ?? MINIMUM_PRE_SYNC_FREE_DISK_GB} GB floor | Chromium destination |`,
                '| --- | ---: | --- | --- |',
                ...capabilities.preparation.volumes.volumes.map(
                  (entry) =>
                    `| \`${entry.volume}\` | ${formatGb(entry.freeDiskGb)} | ${entry.meetsMinimum ? 'yes' : 'no'} | ${entry.isDestinationVolume ? 'yes' : 'no'} |`,
                ),
              ]
            : []),
          '',
        ]
      : []),
    ...(capabilities?.diskMeasurements
      ? [
          '## Disk consumption measurements',
          '',
          '| Stage | Free disk on destination volume |',
          '| --- | ---: |',
          `| Before sync | ${formatGb(capabilities.diskMeasurements.beforeSync)} |`,
          `| After sync | ${formatGb(capabilities.diskMeasurements.afterSync)} |`,
          `| After patch/overlay | ${formatGb(capabilities.diskMeasurements.afterPatch)} |`,
          `| After gn gen | ${formatGb(capabilities.diskMeasurements.afterGnGen)} |`,
          '',
          capabilities.syncUsedShallow
            ? '- Checkout strategy: shallow (`gclient sync --no-history`, depth=1 for every synced repo).'
            : '- Checkout strategy: full history (required for incremental compilation).',
          '',
        ]
      : []),
    '## Milestones',
    '',
    '| Milestone | Result | Evidence / reason |',
    '| --- | --- | --- |',
    ...milestoneVerdicts(stages, mode).map(
      (verdict) => `| ${markdownCell(verdict.text)} | **${markdownCell(verdict.status)}** | ${markdownCell(verdict.detail)} |`,
    ),
    '',
    '## Stage results',
    '',
    '| Stage | Status | Evidence / reason |',
    '| --- | --- | --- |',
    ...stageRows,
    '',
    `- Browser binary artifact: ${artifact?.status ?? 'NOT TESTED'}${artifact?.details ? ` — ${artifact.details}` : ''}`,
  ];
  if (failure) {
    lines.push('', `## Failure or blocker`, '', `**${failure.status}:** ${failure.message}`);
  }
  lines.push('', 'Chromium compilation is claimed only when the corresponding compiler command exits with code 0.', '');
  return `${lines.join('\n')}\n`;
}

function writeSummary(context, overall, failure = null) {
  const contents = makeSummary({ ...context, overall, failure });
  writeFileSync(path.join(context.artifacts, 'build-summary.md'), contents);
  writeFileSync(
    path.join(context.artifacts, 'build-summary.json'),
    `${JSON.stringify(
      {
        overall,
        mode: context.mode,
        runnerSize: context.runnerSize,
        aureliaRevision: context.aureliaRevision,
        chromiumVersion: context.config?.chromium?.version ?? null,
        chromiumRevision: context.config?.chromium?.revision ?? null,
        depotToolsRevision: context.config?.toolchain?.depotTools?.revision ?? null,
        milestones: milestoneVerdicts(context.stages, context.mode),
        stages: context.stages,
        diskMeasurements: context.capabilities?.diskMeasurements ?? null,
        syncUsedShallow: context.capabilities?.syncUsedShallow ?? null,
        failure,
        artifact: context.artifact,
      },
      null,
      2,
    )}\n`,
  );
}

function resourceSample(stage, dest, usagePath) {
  let destinationFreeDiskGb = null;
  try {
    let probe = dest;
    while (!existsSync(probe) && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
    }
    const fs = statfsSync(probe);
    const bytes = Number(fs.bavail) * Number(fs.bsize);
    if (Number.isFinite(bytes) && bytes > 0) {
      destinationFreeDiskGb = Math.round((bytes / 1024 ** 3) * 10) / 10;
    }
  } catch {
    destinationFreeDiskGb = freeDiskGb(dest);
  }
  const sample = {
    timestamp: new Date().toISOString(),
    stage,
    totalMemoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    availableMemoryGb: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    destinationFreeDiskGb,
    freeDiskGb: destinationFreeDiskGb,
    processRssMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
    cpuCores: cpus().length,
  };
  appendFileSync(usagePath, `${JSON.stringify(sample)}\n`);
  return sample;
}

function stopProcessTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    if (result.error === undefined && result.status === 0) {
      return;
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // The child may have exited between the resource sample and this signal.
  }
}

/**
 * Execute one command while teeing complete logs and sampling runner resources.
 *
 * @returns {Promise<{exitCode: number, signal: string|null}>}
 */
export function runMonitoredCommand({
  file,
  args = [],
  cwd = REPO_ROOT,
  env = process.env,
  stage,
  dest,
  logPath,
  usagePath,
  deadlineAt,
  pollIntervalMs = RESOURCE_POLL_INTERVAL_MS,
  minimumFreeDiskGb = MINIMUM_DISK_RESERVE_GB,
  minimumAvailableMemoryGb = MINIMUM_AVAILABLE_MEMORY_GB,
  quiet = false,
}) {
  const command = { file, args, cwd, stdio: ['ignore', 'pipe', 'pipe'] };
  const resolved = resolveSpawn(command, { env });
  const child = spawn(resolved.file, resolved.args, {
    ...resolved.options,
    windowsHide: true,
  });
  const logHeader = [
    `stage: ${stage}`,
    `working directory: ${cwd}`,
    `command: ${resolved.commandLine}`,
    '',
  ].join('\n');
  writeFileSync(logPath, `${logHeader}\n`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopReason = null;
    const output = (chunk) => {
      appendFileSync(logPath, chunk);
      if (!quiet) {
        process.stdout.write(chunk);
      }
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(result);
    };

    const requestStop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      if (!quiet) process.stderr.write(`${reason}\n`);
      stopProcessTree(child);
    };

    const sample = () => {
      try {
        const current = resourceSample(stage, dest, usagePath);
        const reason = resourceLimitReason(current, {
          minimumFreeDiskGb,
          minimumAvailableMemoryGb,
        });
        if (reason !== null) {
          requestStop(reason);
        }
        if (Date.now() >= deadlineAt) {
          requestStop(
            'RESOURCE EXHAUSTED: internal workflow deadline reached',
          );
        }
      } catch (error) {
        requestStop(`RESOURCE EXHAUSTED: resource monitoring failed: ${error.message}`);
      }
    };

    const monitor = setInterval(sample, pollIntervalMs);
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const deadlineTimer = setTimeout(() => {
      requestStop(
        'RESOURCE EXHAUSTED: internal workflow deadline reached',
      );
    }, remainingMs);
    child.once('error', (error) => {
      finish(new ValidationError(`${file} could not be started: ${error.message}`, 'FAIL'));
    });
    child.once('close', (exitCode, signal) => {
      const result = { exitCode, signal };
      if (stopReason !== null) {
        finish(new ValidationError(stopReason, 'RESOURCE EXHAUSTED'));
      } else if (exitCode !== 0) {
        finish(
          new ValidationError(
            `${file} exited with code ${exitCode ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`,
            'FAIL',
          ),
        );
      } else {
        finish(null, result);
      }
    });
    sample();
  });
}

function logCapture(file, args, cwd, env, logPath) {
  const header = [`$ ${file} ${args.join(' ')}`, `cwd: ${cwd}`, ''].join('\n');
  const write = existsSync(logPath) ? appendFileSync : writeFileSync;
  write(logPath, `${header}\n`);
  try {
    const result = captureCommand({ file, args, cwd }, { env });
    appendFileSync(logPath, result.endsWith('\n') ? result : `${result}\n`);
    return result.trim();
  } catch (error) {
    appendFileSync(logPath, `${error.message}\n`);
    throw error;
  }
}

function setStage(context, id, status, details) {
  context.stages[id] = { status, details };
  writeSummary(context, 'IN PROGRESS');
}

async function runCommandStage(context, {
  id,
  label,
  file,
  args,
  cwd,
  env,
  deadlineAt,
  verify,
  minimumFreeDiskGb = null,
  minimumAvailableMemoryGb = MINIMUM_AVAILABLE_MEMORY_GB,
}) {
  setStage(context, id, 'RUNNING', 'Command in progress.');
  context.log(`\n=== ${label} ===`);
  const logPath = path.join(context.logsDir, `${id}.log`);
  // Use the mode-specific free-disk reserve unless the caller overrides it.
  const effectiveMinFreeDiskGb =
    minimumFreeDiskGb !== null ? minimumFreeDiskGb : diskReserveForMode(context.mode);
  try {
    const result = await runMonitoredCommand({
      file,
      args,
      cwd,
      env,
      stage: id,
      dest: context.dest,
      logPath,
      usagePath: context.usagePath,
      deadlineAt,
      pollIntervalMs: context.pollIntervalMs,
      minimumFreeDiskGb: effectiveMinFreeDiskGb,
      minimumAvailableMemoryGb,
      quiet: context.quiet,
    });
    const evidence = verify ? await verify(result) : null;
    setStage(
      context,
      id,
      'PASS',
      evidence ?? `Compiler/tool process exited with code ${result.exitCode}.`,
    );
    return result;
  } catch (error) {
    const status = error.status === 'RESOURCE EXHAUSTED' ? 'RESOURCE EXHAUSTED' : 'FAIL';
    setStage(context, id, status, error.message);
    throw error;
  }
}

function readAureliaRevision() {
  try {
    return captureCommand(
      { file: 'git', args: ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], cwd: REPO_ROOT },
      { env: process.env },
    ).trim();
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown';
  }
}

function getDestFreeDiskGb(dest) {
  let probe = dest;
  while (!existsSync(probe) && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
  }
  try {
    const stats = statfsSync(probe);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(bytes) && bytes > 0
      ? Math.round((bytes / 1024 ** 3) * 10) / 10
      : null;
  } catch {
    return freeDiskGb(probe);
  }
}

function assertGeneratedResources(outDir) {
  const missing = WEBUI_RESOURCE_OUTPUTS.filter(
    (relative) => !existsSync(path.join(outDir, ...relative.split('/'))),
  );
  if (missing.length > 0) {
    throw new ValidationError(
      `resource targets returned success but expected outputs are missing:\n- ${missing.join('\n- ')}`,
      'FAIL',
    );
  }
  return WEBUI_RESOURCE_OUTPUTS;
}

async function buildBrowserArtifact(context, outDir, env, deadlineAt) {
  const artifactStage = 'browser-artifact';
  const stageDir = path.join(context.dest, 'artifacts', 'staged');
  setStage(
    context,
    artifactStage,
    'RUNNING',
    'Checking the runtime size before staging or uploading binaries.',
  );
  const sizePlan = planStaging(outDir);
  const skipArtifact = (details) => {
    context.artifact = { status: 'NOT TESTED', details };
    setStage(context, artifactStage, 'NOT TESTED', details);
  };
  if (sizePlan.problems.length > 0) {
    skipArtifact(`Browser staging skipped: ${sizePlan.problems.join('; ')}`);
    return;
  }
  if (sizePlan.totalBytes > MAX_BROWSER_ARTIFACT_BYTES) {
    skipArtifact(
      `Skipped because the staged runtime is ${(sizePlan.totalBytes / 1024 ** 2).toFixed(1)} MiB, above the ${MAX_BROWSER_ARTIFACT_BYTES / 1024 ** 2} MiB artifact limit.`,
    );
    return;
  }

  const revision = context.aureliaRevision;
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    skipArtifact('Skipped because the checked-out Aurelia revision is not a full SHA.');
    return;
  }

  rmSync(stageDir, { recursive: true, force: true });
  await runCommandStage(context, {
    id: 'browser-staging',
    label: 'Stage full-build runtime (not a smoke-test claim)',
    file: process.execPath,
    args: [
      path.join(REPO_ROOT, 'tools/chromium/stage-runtime.mjs'),
      '--out',
      outDir,
      '--dest',
      stageDir,
      '--aurelia-revision',
      revision,
      '--gn-args',
      path.join(outDir, 'args.gn'),
      '--runner-capabilities',
      path.join(context.artifacts, 'runner-capabilities.json'),
    ],
    cwd: REPO_ROOT,
    env,
    deadlineAt,
    verify: () => {
      const manifestPath = path.join(stageDir, 'build-manifest.json');
      if (!existsSync(path.join(stageDir, 'chrome.exe')) || !existsSync(manifestPath)) {
        throw new ValidationError(
          'staging exited successfully but chrome.exe or build-manifest.json is missing',
          'FAIL',
        );
      }
      return 'Staged chrome.exe and build-manifest.json; no runtime smoke test is claimed.';
    },
  });

  const packagePath = path.join(REPO_ROOT, 'tools/chromium/package.mjs');
  let archive;
  let archiveBytes;
  await runCommandStage(context, {
    id: 'browser-packaging',
    label: 'Package full-build runtime artifact',
    file: process.execPath,
    args: [packagePath, '--stage', stageDir, '--dest', context.artifacts],
    cwd: REPO_ROOT,
    env,
    deadlineAt,
    verify: () => {
      const manifestPath = path.join(stageDir, 'build-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const artifactName = manifest.artifact;
      if (
        typeof artifactName !== 'string' ||
        path.basename(artifactName) !== artifactName ||
        !artifactName.endsWith('.zip')
      ) {
        throw new ValidationError('staged manifest has an invalid browser artifact name', 'FAIL');
      }
      archive = path.join(context.artifacts, artifactName);
      const sidecarPath = `${archive}.sha256`;
      if (!existsSync(archive) || !existsSync(sidecarPath)) {
        throw new ValidationError(
          'packaging exited successfully but the browser zip or SHA-256 sidecar is missing',
          'FAIL',
        );
      }
      const sidecarParts = readFileSync(sidecarPath, 'utf8').trim().split('  ');
      if (
        sidecarParts.length !== 2 ||
        !/^[0-9a-f]{64}$/.test(sidecarParts[0]) ||
        sidecarParts[1] !== artifactName
      ) {
        throw new ValidationError('browser artifact SHA-256 sidecar is malformed', 'FAIL');
      }
      archiveBytes = statSync(archive).size;
      return `Created ${artifactName} and a SHA-256 sidecar (${(archiveBytes / 1024 ** 2).toFixed(1)} MiB).`;
    },
  });

  if (archiveBytes > MAX_BROWSER_ARTIFACT_BYTES) {
    rmSync(archive, { force: true });
    rmSync(`${archive}.sha256`, { force: true });
    skipArtifact(
      `Skipped because the browser zip is ${(archiveBytes / 1024 ** 2).toFixed(1)} MiB, above the ${MAX_BROWSER_ARTIFACT_BYTES / 1024 ** 2} MiB upload limit.`,
    );
    return;
  }
  const details = `${path.basename(archive)} (${(archiveBytes / 1024 ** 2).toFixed(1)} MiB). Full compiler exit code was 0; runtime smoke test was not run.`;
  context.artifact = { status: 'PASS', details, path: archive };
  setStage(context, artifactStage, 'PASS', details);
}
/** Run validation in order and stop at the first failed or blocked stage. */
export async function runValidation({
  mode,
  runnerSize = 'standard',
  dest,
  artifacts,
  config = loadConfig(),
  log = console.log,
  quiet = false,
  deadlineMinutes = null,
  pollIntervalMs = RESOURCE_POLL_INTERVAL_MS,
} = {}) {
  if (!VALIDATION_LEVELS.includes(mode)) {
    throw new ValidationError(`invalid validation level "${mode}"`, 'FAIL');
  }
  if (!RUNNER_SIZES.includes(runnerSize)) {
    throw new ValidationError(`invalid runner size "${runnerSize}"`, 'FAIL');
  }
  if (!dest || !artifacts) {
    throw new ValidationError('both a Chromium destination and artifact directory are required', 'FAIL');
  }

  const resolvedDest = path.resolve(dest);
  const resolvedArtifacts = path.resolve(artifacts);
  const logsDir = path.join(resolvedArtifacts, 'logs');
  mkdirSync(resolvedDest, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const usagePath = path.join(resolvedArtifacts, 'resource-usage.jsonl');
  writeFileSync(usagePath, '');

  const context = {
    mode,
    runnerSize,
    dest: resolvedDest,
    artifacts: resolvedArtifacts,
    logsDir,
    usagePath,
    config,
    stages: Object.fromEntries(
      STAGES.map(([id]) => [id, { status: 'NOT TESTED', details: 'Not reached.' }]),
    ),
    aureliaRevision: readAureliaRevision(),
    capabilities: null,
    requirements: requirementsForMode(config, mode),
    artifact: { status: 'NOT TESTED', details: 'Only full mode can upload a browser binary.' },
    log,
    quiet,
    pollIntervalMs,
  };
  const deadlineAt =
    Date.now() + (deadlineMinutes ?? deadlineMinutesForMode(mode)) * 60_000;
  if (mode === 'gn') {
    for (const id of COMPILE_STAGE_IDS) {
      context.stages[id] = {
        status: 'NOT TESTED',
        details: 'Skipped in gn mode: GN validation never compiles.',
      };
    }
  }
  writeSummary(context, 'IN PROGRESS');

  try {
    log('Measuring the selected GitHub-hosted Windows runner before any Chromium source sync.');
    let builder = checkBuilder({
      dest: resolvedDest,
      config,
      mode,
      log: (line) => log(`runner: ${line}`),
    });
    let destinationFreeDiskGb = getDestFreeDiskGb(resolvedDest);
    const requirements = builder.requirements;
    context.requirements = requirements;

    let preparation = null;
    const canPrepareHostedWindowsRunner =
      isGithubHostedRunner() &&
      process.platform === 'win32' &&
      process.arch === 'x64' &&
      builder.capabilities.cpuCores >= requirements.cpuCores &&
      builder.capabilities.ramGb >= requirements.ramGb &&
      builder.capabilities.visualStudio !== null &&
      builder.capabilities.msvcCompiler !== null;
    const needsDiskCleanup =
      destinationFreeDiskGb === null ||
      destinationFreeDiskGb < requirements.freeDiskGb;
    const needsSdkInstall =
      builder.capabilities.windowsSdk === null ||
      !isSdkVersionCompatible(
        builder.capabilities.windowsSdk,
        REQUIRED_SDK_VERSION,
      );

    if (
      canPrepareHostedWindowsRunner &&
      (needsDiskCleanup || needsSdkInstall)
    ) {
      log(
        'Preparing the GitHub-hosted Windows runner (safe non-Chromium disk cleanup and Windows SDK 10.0.28000.0 provisioning) before source sync.',
      );
      preparation = prepareHostedWindowsRunner({
        dest: resolvedDest,
        artifacts: resolvedArtifacts,
        minimumFreeDiskGb: requirements.freeDiskGb,
        log: (line) => log(`runner-prep: ${line}`),
      });
      builder = checkBuilder({
        dest: resolvedDest,
        config,
        mode,
        log: (line) => log(`runner (post-prep): ${line}`),
      });
      destinationFreeDiskGb = getDestFreeDiskGb(resolvedDest);
    }

    const problems = [...builder.problems];
    if (preparation && !preparation.ok && preparation.problems.length > 0) {
      for (const prepProblem of preparation.problems) {
        if (!problems.includes(prepProblem)) {
          problems.push(prepProblem);
        }
      }
    }
    if (
      destinationFreeDiskGb === null ||
      destinationFreeDiskGb < requirements.freeDiskGb
    ) {
      problems.push(
        `Chromium destination volume: ${formatGb(destinationFreeDiskGb)} (needs ${requirements.freeDiskGb} GB+ on that same volume)`,
      );
    }
    if (!isGithubHostedRunner()) {
      problems.push(
        `runner environment: ${process.env.RUNNER_ENVIRONMENT ?? 'unknown'} (Chromium compilation is allowed only on GitHub-hosted Actions runners)`,
      );
    }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      problems.push(`platform: ${process.platform}/${process.arch} (this workflow builds Windows x64)`);
    }
    // Read-only: tool paths, tool versions and PATH entries whose name
    // mentions git. Never a credential or a token.
    const tooling = describeGitEnvironment({ env: process.env });
    log(
      `runner: git ${tooling.git === null ? 'NOT FOUND' : `${tooling.git.path} (${tooling.git.version})`}`,
    );
    if (process.platform === 'win32') {
      log(
        `runner: git.bat ${tooling.gitBatResolvable ?? 'not resolvable from PATH (a shim is created during sync)'}`,
      );
    }
    log(`runner: python ${tooling.python ?? 'not found on PATH'}`);
    for (const entry of tooling.gitPathEntries) {
      log(`runner: PATH entry with git: ${entry}`);
    }

    context.capabilities = {
      ...builder.capabilities,
      tooling,
      preparation,
      runnerSize,
      destination: resolvedDest,
      destinationFreeDiskGb,
      requirements,
      problems,
      notes: builder.notes,
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? 'unknown',
      chromiumVersion: config.chromium.version,
      chromiumRevision: config.chromium.revision,
      depotToolsRevision: config.toolchain.depotTools.revision,
      validationLevel: mode,
      workflowRunUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
    };
    writeFileSync(
      path.join(resolvedArtifacts, 'runner-capabilities.json'),
      `${JSON.stringify(context.capabilities, null, 2)}\n`,
    );
    resourceSample('runner-preflight', resolvedDest, usagePath);
    if (problems.length > 0) {
      const message = `selected GitHub-hosted runner does not meet the recorded Chromium builder minimums: ${problems.join('; ')}`;
      setStage(context, 'runner-preflight', 'BLOCKED', message);
      writeSummary(context, 'BLOCKED', { status: 'BLOCKED', message });
      log(`BLOCKED: ${message}`);
      return { status: 'BLOCKED', exitCode: 1, summary: path.join(resolvedArtifacts, 'build-summary.md') };
    }
    setStage(
      context,
      'runner-preflight',
      'PASS',
      `${builder.capabilities.cpuCores} CPU core(s), ${formatGb(builder.capabilities.ramGb)} RAM, ${formatGb(destinationFreeDiskGb)} free on the Chromium destination volume.`,
    );

    const toolsDir = path.join(resolvedDest, 'depot_tools');
    const srcDir = path.join(resolvedDest, 'src');
    const outDir = path.join(srcDir, 'out', 'Aurelia');
    const childEnv = {
      ...withPathPrefix(process.env, toolsDir),
      DEPOT_TOOLS_UPDATE: '0',
      DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
      GCLIENT_PY3: '1',
      NINJA_SUMMARIZE_BUILD: '1',
    };

    const diskMeasurements = {
      beforeSync: getDestFreeDiskGb(resolvedDest),
      afterSync: null,
      afterPatch: null,
      afterGnGen: null,
    };
    context.capabilities.diskMeasurements = diskMeasurements;
    log(`disk: before sync -> ${formatGb(diskMeasurements.beforeSync)} free on destination volume`);

    const syncArgs = [
      path.join(REPO_ROOT, 'tools/chromium/sync.mjs'),
      '--dest',
      resolvedDest,
      '--mode',
      mode,
      '--jobs',
      String(syncJobsForMode(mode)),
    ];
    // GN mode uses --no-history by default (see sync.mjs); compilation modes
    // keep full history for incremental sync.

    await runCommandStage(context, {
      id: 'pinned-sync',
      label: 'Install pinned depot_tools and sync the configured Chromium revision',
      file: process.execPath,
      args: syncArgs,
      cwd: REPO_ROOT,
      env: childEnv,
      minimumFreeDiskGb: diskReserveForMode(mode),
      deadlineAt,
      verify: () => {
        diskMeasurements.afterSync = getDestFreeDiskGb(resolvedDest);
        const consumedGb =
          typeof diskMeasurements.beforeSync === 'number' &&
          typeof diskMeasurements.afterSync === 'number'
            ? Math.round(
                (diskMeasurements.beforeSync - diskMeasurements.afterSync) * 10,
              ) / 10
            : null;
        log(
          `disk: after sync -> ${formatGb(diskMeasurements.afterSync)} free (consumed ${formatGb(consumedGb)})`,
        );
        writeFileSync(
          path.join(resolvedArtifacts, 'disk-measurements.json'),
          `${JSON.stringify(diskMeasurements, null, 2)}\n`,
        );
        const actualDepotToolsRevision = captureCommand(
          {
            file: 'git',
            args: ['-C', toolsDir, 'rev-parse', 'HEAD'],
            cwd: REPO_ROOT,
          },
          { env: childEnv },
        ).trim();
        assertPinnedRevision(
          config.toolchain.depotTools.revision,
          actualDepotToolsRevision,
          'depot_tools',
        );
        const actualChromiumRevision = captureCommand(
          {
            file: 'git',
            args: ['-C', srcDir, 'rev-parse', 'HEAD'],
            cwd: REPO_ROOT,
          },
          { env: childEnv },
        ).trim();
        assertPinnedRevision(config.chromium.revision, actualChromiumRevision);
        context.capabilities.actualDepotToolsRevision = actualDepotToolsRevision;
        context.capabilities.actualChromiumRevision = actualChromiumRevision;
        context.capabilities.syncUsedShallow = mode === 'gn';
        writeFileSync(
          path.join(resolvedArtifacts, 'runner-capabilities.json'),
          `${JSON.stringify(context.capabilities, null, 2)}\n`,
        );
        return `Chromium ${config.chromium.version} verified at ${actualChromiumRevision} (${mode === 'gn' ? 'shallow --no-history checkout' : 'full-history checkout'}); depot_tools verified at ${actualDepotToolsRevision}; consumed ${formatGb(consumedGb)}.`;
      },
    });

    await runCommandStage(context, {
      id: 'patch-verification',
      label: 'Verify the patch set against the pristine pinned checkout',
      file: process.execPath,
      args: [
        path.join(REPO_ROOT, 'tools/chromium/cli.mjs'),
        'verify-patches',
        '--checkout',
        srcDir,
      ],
      cwd: REPO_ROOT,
      env: childEnv,
      deadlineAt,
    });

    await runCommandStage(context, {
      id: 'overlay-application',
      label: 'Apply the Aurelia overlay and Chromium patch with existing tooling',
      file: process.execPath,
      args: [
        path.join(REPO_ROOT, 'tools/chromium/install-overlay.mjs'),
        '--checkout',
        srcDir,
      ],
      cwd: REPO_ROOT,
      env: childEnv,
      deadlineAt,
      verify: () => {
        diskMeasurements.afterPatch = getDestFreeDiskGb(resolvedDest);
        const sinceSync =
          typeof diskMeasurements.afterSync === 'number' &&
          typeof diskMeasurements.afterPatch === 'number'
            ? Math.round(
                (diskMeasurements.afterSync - diskMeasurements.afterPatch) * 10,
              ) / 10
            : null;
        log(
          `disk: after patch/overlay -> ${formatGb(diskMeasurements.afterPatch)} free (patch/overlay consumed ${formatGb(sinceSync)})`,
        );
        writeFileSync(
          path.join(resolvedArtifacts, 'disk-measurements.json'),
          `${JSON.stringify(diskMeasurements, null, 2)}\n`,
        );
        return 'Aurelia overlay and patch applied; disk after patch recorded.';
      },
    });

    await runCommandStage(context, {
      id: 'fork-delta',
      label: 'Check the reviewed fork-delta budget',
      file: process.execPath,
      args: [path.join(REPO_ROOT, 'tools/chromium/cli.mjs'), 'fork-delta', '--check'],
      cwd: REPO_ROOT,
      env: childEnv,
      deadlineAt,
    });

    const gnArgsFile = path.join(REPO_ROOT, 'config/gn/win-x64-dev.gn');
    await runCommandStage(context, {
      id: 'gn-argument-policy',
      label: 'Validate the reviewed Windows x64 GN arguments',
      file: process.execPath,
      args: [path.join(REPO_ROOT, 'tools/chromium/gn-args.mjs'), gnArgsFile],
      cwd: REPO_ROOT,
      env: childEnv,
      deadlineAt,
    });
    const renderedGnArgs = logCapture(
      process.execPath,
      [path.join(REPO_ROOT, 'tools/chromium/gn-args.mjs'), '--print', gnArgsFile],
      REPO_ROOT,
      childEnv,
      path.join(context.logsDir, 'gn-arguments.log'),
    );
    writeFileSync(path.join(resolvedArtifacts, 'gn-arguments.txt'), `${renderedGnArgs}\n`);

    // gclient.bat skips update_depot_tools.bat with DEPOT_TOOLS_UPDATE=0.
    // Initialize the checked-out Windows Python via its standalone bootstrap,
    // not the updater (which would check out moving origin/main). gn.bat needs
    // python3_bin_reldir.txt even though gclient sync itself already passed.
    if (process.platform === 'win32') {
      await runCommandStage(context, {
        id: 'depot-tools-bootstrap',
        label: 'Initialize pinned depot_tools Python for GN without updating Git',
        file: process.execPath,
        args: [
          path.join(REPO_ROOT, 'tools/chromium/bootstrap-depot-tools.mjs'),
          toolsDir,
          config.toolchain.depotTools.revision,
        ],
        cwd: REPO_ROOT,
        env: childEnv,
        deadlineAt,
      });
    }

    const argsGn = path.join(outDir, 'args.gn');
    await runCommandStage(context, {
      id: 'gn-generation',
      label: 'Generate the pinned Chromium Windows x64 build graph',
      file: 'gn',
      args: ['gen', path.relative(srcDir, outDir), `--args=${renderedGnArgs}`],
      cwd: srcDir,
      env: childEnv,
      minimumFreeDiskGb: diskReserveForMode(mode),
      deadlineAt,
      verify: () => {
        if (!existsSync(argsGn)) {
          throw new ValidationError('gn gen exited successfully but out/Aurelia/args.gn was not created', 'FAIL');
        }
        diskMeasurements.afterGnGen = getDestFreeDiskGb(resolvedDest);
        const gnConsumedGb =
          typeof diskMeasurements.afterPatch === 'number' &&
          typeof diskMeasurements.afterGnGen === 'number'
            ? Math.round(
                (diskMeasurements.afterPatch - diskMeasurements.afterGnGen) * 10,
              ) / 10
            : null;
        const totalConsumed =
          typeof diskMeasurements.beforeSync === 'number' &&
          typeof diskMeasurements.afterGnGen === 'number'
            ? Math.round(
                (diskMeasurements.beforeSync - diskMeasurements.afterGnGen) * 10,
              ) / 10
            : null;
        log(
          `disk: after gn gen -> ${formatGb(diskMeasurements.afterGnGen)} free (GN consumed ${formatGb(gnConsumedGb)}; total consumed ${formatGb(totalConsumed)})`,
        );
        writeFileSync(
          path.join(resolvedArtifacts, 'disk-measurements.json'),
          `${JSON.stringify(diskMeasurements, null, 2)}\n`,
        );
        return `GN generated out/Aurelia/args.gn. Total disk consumed through GN gen: ${formatGb(totalConsumed)}.`;
      },
    });

    await runCommandStage(context, {
      id: 'gn-effective-arguments',
      label: 'Validate the effective GN arguments generated for this build',
      file: process.execPath,
      args: [path.join(REPO_ROOT, 'tools/chromium/gn-args.mjs'), argsGn],
      cwd: REPO_ROOT,
      env: childEnv,
      deadlineAt,
      verify: () => {
        copyFileSync(argsGn, path.join(resolvedArtifacts, 'args.gn'));
        return 'The actual out/Aurelia/args.gn passed the reviewed argument policy and was archived.';
      },
    });

    const targetCheckLog = path.join(context.logsDir, 'target-labels.log');
    setStage(context, 'target-labels', 'RUNNING', 'Resolving selected targets, dependencies and declared outputs in the GN graph.');
    try {
      const targetRows = verifyGnTargets({
        srcDir,
        outDir,
        runDesc: (args) =>
          logCapture('gn', args, srcDir, childEnv, targetCheckLog),
      });
      setStage(context, 'target-labels', 'PASS', targetRows.join('; '));
    } catch (error) {
      setStage(context, 'target-labels', 'FAIL', error.message);
      throw error;
    }

    // Pinned GN accepts only one optional label/pattern per `gn check` command.
    // Keep the stage RUNNING until both independent checks complete successfully.
    setStage(context, 'gn-check', 'RUNNING', 'Checking both controller targets.');
    try {
      for (const { target, args } of scopedGnCheckCommands(
        srcDir,
        outDir,
        TARGETED_CPP_TARGETS,
      )) {
        await runMonitoredCommand({
          file: 'gn',
          args,
          cwd: srcDir,
          env: childEnv,
          stage: 'gn-check',
          dest: context.dest,
          logPath: path.join(
            context.logsDir,
            `gn-check-${target.split(':').at(-1)}.log`,
          ),
          usagePath: context.usagePath,
          deadlineAt,
          pollIntervalMs: context.pollIntervalMs,
          minimumFreeDiskGb: diskReserveForMode(mode),
          quiet: context.quiet,
        });
      }
      setStage(
        context,
        'gn-check',
        'PASS',
        `GN checked ${TARGETED_CPP_TARGETS.join(' and ')}.`,
      );
    } catch (error) {
      const status =
        error.status === 'RESOURCE EXHAUSTED' ? 'RESOURCE EXHAUSTED' : 'FAIL';
      setStage(context, 'gn-check', status, error.message);
      throw error;
    }

    if (mode !== 'gn') {
    await runCommandStage(context, {
      id: 'webui-resources',
      label: 'Build WebUI TypeScript, GRIT resource descriptions, headers, maps, and pak files',
      file: 'autoninja',
      args: [
        '-C',
        path.relative(srcDir, outDir),
        '-j',
        String(MAX_BUILD_JOBS),
        ...WEBUI_RESOURCE_TARGETS,
      ],
      cwd: srcDir,
      env: childEnv,
      deadlineAt,
      verify: () => {
        const generated = assertGeneratedResources(outDir);
        return `All ${generated.length} expected TypeScript, GRIT, resource-map, and pak outputs exist.`;
      },
    });
    }

    if (mode === 'targeted' || mode === 'full') {
      await runCommandStage(context, {
        id: 'targeted-cpp',
        label: 'Compile Aurelia WebUI controllers and their C++ dependencies',
        file: 'autoninja',
        args: [
          '-C',
          path.relative(srcDir, outDir),
          '-j',
          String(MAX_BUILD_JOBS),
          ...TARGETED_CPP_TARGETS,
        ],
        cwd: srcDir,
        env: childEnv,
        deadlineAt,
      });
    }

    if (mode === 'full') {
      await runCommandStage(context, {
        id: 'full-chrome',
        label: 'Compile the full Chromium browser target after targeted validation passes',
        file: 'autoninja',
        args: [
          '-C',
          path.relative(srcDir, outDir),
          '-j',
          String(MAX_BUILD_JOBS),
          'chrome',
        ],
        cwd: srcDir,
        env: childEnv,
        deadlineAt,
      });
      await buildBrowserArtifact(context, outDir, childEnv, deadlineAt);
    }

    writeSummary(context, 'PASS');
    log(
      mode === 'gn'
        ? 'PASS: gn validation completed. GN GEN PASS only; COMPILATION NOT TESTED.'
        : `PASS: ${mode} validation completed. Chromium compiler success is recorded only for commands that exited with code 0.`,
    );
    return { status: 'PASS', exitCode: 0, summary: path.join(resolvedArtifacts, 'build-summary.md') };
  } catch (error) {
    const status =
      error.status === 'RESOURCE EXHAUSTED' || error.status === 'BLOCKED'
        ? error.status
        : 'FAIL';
    const message = error.message ?? String(error);
    const active = STAGES.map(([id]) => id).find(
      (id) => context.stages[id]?.status === 'RUNNING',
    );
    if (active) {
      context.stages[active] = { status, details: message };
    }
    writeSummary(context, status, { status, message });
    log(`${status}: ${message}`);
    return { status, exitCode: 1, summary: path.join(resolvedArtifacts, 'build-summary.md') };
  }
}

function main(argv) {
  const options = parseValidationOptions(argv);
  return runValidation(options);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    const status = error.status ?? 'FAIL';
    console.error(`${status}: ${error.message}`);
    process.exitCode = 1;
  }
}

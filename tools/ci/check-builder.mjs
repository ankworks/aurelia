#!/usr/bin/env node
/**
 * Preflight check for a machine that is meant to build Aurelia.
 *
 * Run this *before* syncing anything: a Chromium checkout plus build output is
 * the expensive part, and discovering at hour five that the machine is too
 * small wastes a day. The workflow runs the same script, so the CI verdict and
 * the on-machine verdict cannot disagree.
 *
 * It only reads. It never installs, never changes settings, and never writes
 * outside the file named by --record.
 *
 * Requirements depend on the validation mode:
 *   gn               GN generation and gn check only (no compilation). Uses the
 *                    reduced `buildRequirements.gnValidation` profile.
 *   targeted, full   Compilation. Uses the strict `buildRequirements.referenceBuilder`
 *                    gate (8 cores / 32 GB / 150 GB), which is never lowered.
 *
 * Usage:
 *   node tools/ci/check-builder.mjs
 *   node tools/ci/check-builder.mjs --mode gn
 *   node tools/ci/check-builder.mjs --dest D:\chromium
 *   node tools/ci/check-builder.mjs --record artifacts/runner-capabilities.json
 *   node tools/ci/check-builder.mjs --json
 *
 * Exit codes: 0 the resource/toolchain gate passes, 1 it fails, 2 the check itself failed.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync as fsReaddirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, totalmem, arch } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/entry.mjs';
import { detectWindowsToolchain } from '../chromium/lib/windows-toolchain.mjs';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Directories the check may inspect for free space. */
export function candidateDestinations(dest) {
  const fromEnv = process.env.AURELIA_CHROMIUM_DEST;
  const candidates = [dest, fromEnv, path.join(REPO_ROOT, '..')].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  const withParents = candidates.flatMap((value) => {
    const resolved = path.resolve(value);
    return existsSync(resolved)
      ? [resolved]
      : [path.dirname(resolved), resolved];
  });
  return [...new Set(withParents)].filter((value) => existsSync(value));
}

/** Free space in GB on the volume holding `target`, or null when unknown. */
export function freeDiskGb(target) {
  try {
    const stats = statfsSync(target);
    return Math.round(((stats.bavail * stats.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

function toolVersion(
  command,
  args = ['--version'],
  { spawn = spawnSync, env = process.env } = {},
) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    env,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return text.length > 0 ? text.split('\n')[0] : 'present';
}

export const PREFLIGHT_MODES = Object.freeze(['gn', 'targeted', 'full']);

/** Documented fallbacks, used only when the pin configuration omits a profile. */
const REFERENCE_BUILDER_FALLBACK = Object.freeze({
  cpuCores: 8,
  ramGb: 32,
  freeDiskGb: 150,
});
const GN_VALIDATION_FALLBACK = Object.freeze({
  cpuCores: 4,
  ramGb: 15.5,
  freeDiskGb: 150,
});

function assertRequirementProfile(profile, name) {
  for (const key of ['cpuCores', 'ramGb', 'freeDiskGb']) {
    const value = profile[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${name}.${key} must be a positive number; got ${value}`);
    }
  }
  return profile;
}

/**
 * Select the resource profile for a validation mode.
 *
 * `gn` gets the reduced GN-only profile; `targeted` and `full` always get the
 * strict reference builder. An unknown mode throws instead of guessing.
 */
export function requirementsForMode(config, mode = 'full') {
  if (mode === 'gn') {
    return {
      ...assertRequirementProfile(
        config?.buildRequirements?.gnValidation ?? GN_VALIDATION_FALLBACK,
        'gnValidation',
      ),
    };
  }
  if (mode === 'targeted' || mode === 'full') {
    return {
      ...assertRequirementProfile(
        config?.buildRequirements?.referenceBuilder ??
          REFERENCE_BUILDER_FALLBACK,
        'referenceBuilder',
      ),
    };
  }
  throw new Error(
    `unknown validation mode "${mode}"; choose ${PREFLIGHT_MODES.join(', ')}`,
  );
}

/**
 * Pure comparison of measured capabilities with a requirement profile.
 * Returns the human-readable problems; an empty array means the resource gate passes.
 */
export function evaluateResources(
  { cpuCores, ramGb, bestFreeDiskGb },
  requirements,
) {
  const problems = [];
  if (cpuCores < requirements.cpuCores) {
    problems.push(
      `logical cores: ${cpuCores} (needs ${requirements.cpuCores}+)`,
    );
  }
  if (ramGb < requirements.ramGb) {
    problems.push(`RAM: ${ramGb} GB (needs ${requirements.ramGb} GB+)`);
  }
  if (bestFreeDiskGb < requirements.freeDiskGb) {
    problems.push(
      `free disk: ${bestFreeDiskGb} GB (needs ${requirements.freeDiskGb} GB+ on one volume for Chromium sources, dependencies and build outputs)`,
    );
  }
  return problems;
}

/**
 * @returns {{ok: boolean, mode: string, capabilities: object, problems: string[], notes: string[], requirements: object}}
 */
export function checkBuilder({
  dest,
  config,
  mode = 'full',
  env = process.env,
  platform: plat = platform(),
  spawn = spawnSync,
  exists = existsSync,
  readdirSync = fsReaddirSync,
  log = () => {},
} = {}) {
  const requirements = requirementsForMode(config, mode);
  const toolchain =
    plat === 'win32'
      ? detectWindowsToolchain({
          env,
          platform: plat,
          spawn,
          exists,
          readdirSync,
        })
      : null;

  const capabilities = {
    platform: plat,
    platformRelease: release(),
    architecture: arch(),
    cpuModel: cpus()[0]?.model?.trim() ?? 'unknown',
    cpuCores: cpus().length,
    ramGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    git: toolVersion('git', ['--version'], { spawn, env }),
    python:
      toolVersion('python', ['--version'], { spawn, env }) ??
      toolVersion('python3', ['--version'], { spawn, env }),
    depotToolsWinToolchain: env.DEPOT_TOOLS_WIN_TOOLCHAIN ?? null,
    visualStudio: toolchain?.vs?.installationPath ?? null,
    visualStudioVersion: toolchain?.vs?.version ?? null,
    msvcToolset: toolchain?.vs?.msvcToolsetVersion ?? null,
    msvcCompiler: toolchain?.vs?.clExe ?? null,
    windowsSdk: toolchain?.sdk?.selectedVersion ?? null,
    windowsSdkDir: toolchain?.sdk?.sdkDir ?? null,
    freeDisk: {},
    checkedAt: new Date().toISOString(),
  };

  const problems = [];
  const notes = [];

  if (toolchain !== null) {
    problems.push(...toolchain.problems);
    notes.push(...toolchain.notes);
  }

  const dirs = candidateDestinations(dest);
  for (const dir of dirs) {
    const free = freeDiskGb(dir);
    capabilities.freeDisk[dir] = free;
    if (free === null) {
      notes.push(`free space at ${dir} could not be determined`);
    }
  }
  const best = Math.max(
    ...Object.values(capabilities.freeDisk).filter(
      (value) => typeof value === 'number',
    ),
    0,
  );
  capabilities.freeDiskGb = best;

  problems.push(
    ...evaluateResources(
      {
        cpuCores: capabilities.cpuCores,
        ramGb: capabilities.ramGb,
        bestFreeDiskGb: best,
      },
      requirements,
    ),
  );
  if (capabilities.git === null) {
    problems.push('git was not found on PATH');
  }
  if (capabilities.python === null) {
    notes.push('python was not found on PATH; depot_tools needs it');
  }
  if (plat !== 'win32') {
    const hasCompiler = ['clang++', 'g++'].some(
      (compiler) =>
        toolVersion(compiler, ['--version'], { spawn, env }) !== null,
    );
    if (!hasCompiler) {
      notes.push('no C++ compiler found on PATH (clang++ or g++)');
    }
  }

  for (const [dir, free] of Object.entries(capabilities.freeDisk)) {
    log(`free space: ${dir} -> ${free === null ? 'unknown' : `${free} GB`}`);
  }
  log(
    `cpu: ${capabilities.cpuCores} logical core(s), ram: ${capabilities.ramGb} GB`,
  );
  if (capabilities.visualStudio !== null) {
    log(
      `visual studio: ${capabilities.visualStudio}${
        capabilities.visualStudioVersion
          ? ` (${capabilities.visualStudioVersion})`
          : ''
      }`,
    );
  }
  if (capabilities.msvcCompiler !== null) {
    log(
      `msvc compiler: ${capabilities.msvcCompiler}${
        capabilities.msvcToolset ? ` (${capabilities.msvcToolset})` : ''
      }`,
    );
  }
  if (capabilities.windowsSdk !== null) {
    log(
      `windows sdk: ${capabilities.windowsSdk}${
        capabilities.windowsSdkDir ? ` (${capabilities.windowsSdkDir})` : ''
      }`,
    );
  }
  if (capabilities.depotToolsWinToolchain !== null) {
    log(`DEPOT_TOOLS_WIN_TOOLCHAIN: ${capabilities.depotToolsWinToolchain}`);
  }

  return {
    ok: problems.length === 0,
    mode,
    capabilities,
    problems,
    notes,
    requirements,
  };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(`Measure whether this machine meets Aurelia's Chromium builder resource gate. This does not authorize compilation.

  --mode <m>      gn | targeted | full (default full; gn uses the reduced GN-only profile)
  --dest <dir>    directory that will hold the Chromium checkout
                  (defaults to AURELIA_CHROMIUM_DEST, then the repo parent)
  --record <file> write the capabilities JSON (used by the build manifest)
  --json          print the result as JSON
  --no-fail       report but exit 0 (for exploratory runs)`);
      process.exitCode = 0;
    } else {
      const { loadConfig } = await import('../chromium/lib/config.mjs');
      const result = checkBuilder({
        dest: valueOf('--dest'),
        mode: valueOf('--mode') ?? 'full',
        config: loadConfig(),
        log: (line) => console.log(line),
      });

      for (const note of result.notes) {
        console.log(`note: ${note}`);
      }
      for (const problem of result.problems) {
        console.error(`problem: ${problem}`);
      }

      const record = valueOf('--record');
      if (record !== undefined) {
        mkdirSync(path.dirname(path.resolve(record)), { recursive: true });
        writeFileSync(
          record,
          `${JSON.stringify(
            {
              ...result.capabilities,
              requirements: result.requirements,
              problems: result.problems,
              notes: result.notes,
            },
            null,
            2,
          )}\n`,
        );
        console.log(`recorded: ${record}`);
      }

      if (argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('');
        console.log(
          result.ok
            ? 'BUILDER OK: this machine meets the documented minimums'
            : 'BUILDER TOO SMALL: see the problems above; do not start a full sync here',
        );
      }
      process.exitCode = result.ok || argv.includes('--no-fail') ? 0 : 1;
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
  }
}

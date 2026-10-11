#!/usr/bin/env node
/**
 * Reproducible Chromium checkout for an adequately provisioned machine.
 *
 * This script is deliberately NOT run in the fast CI or in small sandboxes: a
 * Chromium source tree plus its dependencies needs well over 100 GB and takes a
 * long time to fetch. See docs/BUILDING-CHROMIUM.md for measured requirements.
 *
 * What it does:
 *   1. preflight: disk space, platform, and whether depot_tools is available;
 *   2. fetch/refresh depot_tools and check out the pinned revision if one is
 *      recorded in config/chromium_version.json;
 *   3. on Windows, create the `git.bat` shim depot_tools' git_cache.py needs
 *      (see lib/windows-git.mjs), then create the gclient solution for the
 *      pinned Chromium revision and sync dependencies (branch heads and tags
 *      are only fetched with --with-refs: they cost a lot of time and disk and
 *      the pinned revision does not need them);
 *   4. verify the checkout HEAD equals the pinned revision;
 *   5. optionally install the Aurelia overlay and patch set.
 *
 * Usage:
 *   node tools/chromium/sync.mjs --dest C:\\chromium --install
 *   node tools/chromium/sync.mjs --dest /srv/chromium --check-only
 *   node tools/chromium/sync.mjs --dest /srv/chromium --jobs 4
 *   node tools/chromium/sync.mjs --record-depot-tools <sha>
 *   node tools/chromium/sync.mjs --dest C:\\chromium --with-refs   # + branch heads/tags
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, loadConfig, CONFIG_PATH } from './lib/config.mjs';
import { installOverlay } from './install-overlay.mjs';
import { run } from './lib/upstream.mjs';
import { spawnCommand, withPathPrefix } from './lib/exec.mjs';
import {
  GIT_BAT_NAME,
  GIT_SHIM_DIR_NAME,
  ensureWindowsGitShim,
  executableVersion,
  pathEntries,
  resolveGitExecutable,
  resolvesInPathEntries,
  whereExecutable,
} from './lib/windows-git.mjs';
import {
  describeWindowsToolchain,
  detectWindowsToolchain,
} from './lib/windows-toolchain.mjs';
import { isMainModule } from '../lib/entry.mjs';

const CHROMIUM_SOURCE_URL =
  'https://chromium.googlesource.com/chromium/src.git';

/** Minimum free space in GB before we even try: source + deps + build output. */
export const MINIMUM_FREE_DISK_GB = 150;

/** The pinned checkout always requires the reviewed 150 GB free-disk floor. */
export function diskFloorGb() {
  return MINIMUM_FREE_DISK_GB;
}

/**
 * Free space in GB, cross-platform.
 *
 * `fs.statfsSync` is used first because it works on Linux, macOS and Windows
 * (the supported Chromium build workflow uses a native Windows runner, where
 * `df` does not exist).
 * `df` remains as a fallback for filesystems statfs cannot report.
 */
export function freeDiskGb(targetPath) {
  try {
    const stats = statfsSync(targetPath);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(available) && available > 0) {
      return available / 1024 ** 3;
    }
  } catch {
    // fall through to df
  }
  const output = run('df', ['-P', '-k', targetPath]);
  const lines = output.trim().split('\n');
  const columns = lines[lines.length - 1].split(/\s+/);
  const availableKb = Number(columns[3]);
  if (!Number.isFinite(availableKb)) {
    throw new Error(`could not parse df output: ${output}`);
  }
  return availableKb / (1024 * 1024);
}

/** Platform-specific name of the gclient entry point. */
export function gclientExecutable(depotTools) {
  return path.join(
    depotTools,
    process.platform === 'win32' ? 'gclient.bat' : 'gclient',
  );
}

/** Build the exact gclient arguments, with bounded sync concurrency if set. */
export function gclientSyncArgs({ revision, withRefs = false, jobs = null } = {}) {
  if (jobs !== null && (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)) {
    throw new Error('--jobs must be an integer from 1 through 32');
  }
  const args = ['sync'];
  if (jobs !== null) {
    args.push('--jobs', String(jobs));
  }
  args.push('--revision', `src@${revision}`);
  if (withRefs) {
    args.push('--with_branch_heads', '--with_tags');
  }
  return args;
}

export function parseJobs(value) {
  if (value === undefined) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('--jobs must be an integer from 1 through 32');
  }
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32) {
    throw new Error('--jobs must be an integer from 1 through 32');
  }
  return jobs;
}

/**
 * Executable and PATH diagnostics, run against the *same* environment the
 * gclient child process will inherit.
 *
 * Everything reported here is a tool path, a tool version, or a PATH entry
 * whose name mentions git. No credential, token or URL is ever printed.
 *
 * @returns {{lines: string[], problems: string[]}}
 */
export function toolingDiagnostics({
  depotTools = null,
  env = process.env,
  platform = process.platform,
  windowsGit = null,
  spawn = spawnSync,
  exists = existsSync,
  readdir = readdirSync,
  readdirSync: readdirOpt,
} = {}) {
  const dirReader = readdirOpt ?? readdir;
  const lines = [];
  const problems = [];
  const entries = pathEntries(env, platform);

  const git = resolveGitExecutable({ env, platform, spawn, exists });
  if (git === null) {
    problems.push(
      platform === 'win32'
        ? 'no working git.exe was found on PATH or in the Git for Windows install directories'
        : 'no working git executable was found on PATH',
    );
    lines.push('git: NOT FOUND');
  } else {
    lines.push(`git: ${git.path} (${git.version})`);
  }

  if (platform === 'win32') {
    const whereGit = whereExecutable('git', { env, spawn });
    lines.push(
      whereGit.length === 0
        ? 'where.exe git: no matches'
        : `where.exe git: ${whereGit.join('; ')}`,
    );
    // The confirmed failure: git_cache.py runs "git.bat", not "git".
    const gitBat = resolvesInPathEntries(GIT_BAT_NAME, entries, { exists });
    const shimNote =
      windowsGit !== null && gitBat !== null && gitBat === windowsGit.gitBat
        ? ` (generated shim for ${windowsGit.gitExecutable})`
        : '';
    lines.push(
      `git.bat: ${gitBat ?? 'NOT RESOLVABLE from PATH'}${shimNote}`,
    );
  }

  const python = executableVersion('python', { env, spawn });
  lines.push(
    `python: ${python ?? 'NOT FOUND on PATH (depot_tools bootstraps its own interpreter)'}`,
  );
  if (platform === 'win32') {
    const wherePython = whereExecutable('python', { env, spawn });
    if (wherePython.length > 0) {
      lines.push(`where.exe python: ${wherePython.join('; ')}`);
    }
  }

  if (depotTools !== null) {
    const gclient = gclientExecutable(depotTools);
    lines.push(
      `gclient entry point: ${gclient}${exists(gclient) ? '' : ' (MISSING)'}`,
    );
    if (!exists(gclient)) {
      problems.push(`the gclient entry point is missing: ${gclient}`);
    }
  }

  const gitEntries = entries.filter((entry) =>
    entry.toLowerCase().includes('git'),
  );
  lines.push(
    gitEntries.length === 0
      ? 'PATH entries containing "git": none'
      : `PATH entries containing "git": ${gitEntries.join('; ')}`,
  );

  const toolchainDesc = describeWindowsToolchain({
    env,
    platform,
    spawn,
    exists,
    readdirSync: dirReader,
  });
  lines.push(...toolchainDesc.lines);
  problems.push(...toolchainDesc.problems);

  return { lines, problems };
}

export function preflight({
  dest,
  config,
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  readdir = readdirSync,
}) {
  const reports = [];
  const problems = [];
  const floorGb = diskFloorGb();

  let probePath = dest;
  while (!existsSync(probePath) && probePath !== path.dirname(probePath)) {
    probePath = path.dirname(probePath);
  }
  try {
    const freeGb = freeDiskGb(probePath);
    reports.push(
      `free disk at ${probePath}: ${freeGb.toFixed(1)} GB (need >= ${floorGb} GB)`,
    );
    if (freeGb < floorGb) {
      problems.push(
        `insufficient free disk: ${freeGb.toFixed(1)} GB available, ${floorGb} GB required`,
      );
    }
  } catch (error) {
    reports.push(`free disk: could not determine (${error.message})`);
    problems.push(`free disk could not be determined for ${probePath}; refusing to sync`);
  }

  if (config.toolchain?.depotTools?.revision === null) {
    reports.push(
      'depot_tools revision is unresolved in config/chromium_version.json; the checkout will use whatever revision is present and must be recorded afterwards',
    );
  }

  // Executables, checked before a single byte of Chromium is fetched so the
  // failure names the missing tool instead of surfacing as an opaque error
  // from inside depot_tools.
  const git = resolveGitExecutable({ env, platform, spawn, exists });
  if (git === null) {
    problems.push(
      platform === 'win32'
        ? 'no working git.exe was found on PATH or in the Git for Windows install directories'
        : 'git was not found on PATH',
    );
  } else {
    reports.push(`git: ${git.path} (${git.version})`);
  }
  if (platform === 'win32' && git !== null) {
    const gitBat = resolvesInPathEntries(
      GIT_BAT_NAME,
      pathEntries(env, platform),
      { exists },
    );
    reports.push(
      gitBat === null
        ? `git.bat is not on PATH; depot_tools git_cache.py runs "git.bat" (not "git") on Windows, so a shim is created in ${GIT_SHIM_DIR_NAME} before gclient starts`
        : `git.bat: ${gitBat}`,
    );
  }

  if (platform === 'win32') {
    const toolchain = detectWindowsToolchain({
      env,
      platform,
      spawn,
      exists,
      readdirSync: readdir,
    });
    if (toolchain !== null) {
      if (toolchain.problems.length > 0) {
        problems.push(...toolchain.problems);
      }
      for (const line of describeWindowsToolchain({
        env,
        platform,
        spawn,
        exists,
        readdirSync: readdir,
      }).lines) {
        reports.push(`toolchain: ${line}`);
      }
    }
  }

  return { reports, problems };
}

function depotToolsDir(dest) {
  return path.join(dest, 'depot_tools');
}

export function ensureDepotTools({ dest, config, log }) {
  const toolchain = config.toolchain?.depotTools;
  const directory = depotToolsDir(dest);

  if (existsSync(directory)) {
    const current = run('git', ['-C', directory, 'rev-parse', 'HEAD']).trim();
    log(`depot_tools present at ${current}`);
    if (toolchain?.revision != null && current !== toolchain.revision) {
      log(`checking out pinned depot_tools ${toolchain.revision}`);
      // Fetch the refs first, then check out the revision: not every git host
      // allows fetching an arbitrary SHA directly, but every host serves the
      // history the pinned revision lives in.
      run('git', ['-C', directory, 'fetch', '--prune', 'origin']);
      run('git', ['-C', directory, 'checkout', '--detach', toolchain.revision]);
    }
    return directory;
  }

  if (toolchain?.source === undefined) {
    throw new Error('config/chromium_version.json has no toolchain.depotTools.source');
  }
  log(`cloning depot_tools from ${toolchain.source}`);
  mkdirSync(dest, { recursive: true });
  run('git', ['clone', toolchain.source, directory]);
  if (toolchain.revision != null) {
    run('git', ['-C', directory, 'checkout', '--detach', toolchain.revision]);
  }
  return directory;
}

function writeGclientFile(dest) {
  const gclientPath = path.join(dest, '.gclient');
  const contents = `# Aurelia Browser - generated by tools/chromium/sync.mjs.
# Do not edit by hand; the pinned revision is managed by the tooling.
solutions = [
  {
    "name": "src",
    "url": "${CHROMIUM_SOURCE_URL}",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {},
  },
]
`;
  writeFileSync(gclientPath, contents);
  return gclientPath;
}

export function syncCheckout({
  dest,
  install = false,
  withRefs = false,
  jobs = null,
  config,
  log = console.log,
}) {
  const preflightResult = preflight({ dest, config });
  for (const report of preflightResult.reports) {
    log(`preflight: ${report}`);
  }
  if (preflightResult.problems.length > 0) {
    throw new Error(preflightResult.problems.join('; '));
  }

  const depotTools = ensureDepotTools({ dest, config, log });
  writeGclientFile(dest);

  // Windows only: depot_tools' git_cache.py runs "git.bat", which neither
  // depot_tools nor Git for Windows ships. Without the shim, gclient sync
  // dies with FileNotFoundError [WinError 2] in Mirror.GetCachePath() before
  // the first fetch. Creating it here - inside the Chromium destination - is
  // the fix; the git cache itself stays enabled and governed by gclient.
  const windowsGit = ensureWindowsGitShim({ dest, env: process.env, log });

  // Spread the ambient environment: Windows needs SystemRoot, TEMP and
  // USERPROFILE for Python and git to work at all, and a stripped environment
  // would fail in ways that look like unrelated toolchain errors.
  const env = {
    ...withPathPrefix(process.env, depotTools, windowsGit?.directory),
    DEPOT_TOOLS_UPDATE: '0',
    DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
    GCLIENT_PY3: '1',
  };

  const tooling = toolingDiagnostics({ depotTools, env, windowsGit });
  for (const line of tooling.lines) {
    log(`tooling: ${line}`);
  }
  if (tooling.problems.length > 0) {
    throw new Error(
      `sync tooling is incomplete; refusing to start gclient: ${tooling.problems.join('; ')}`,
    );
  }

  const srcDir = path.join(dest, 'src');
  log(`syncing Chromium at ${config.chromium.revision} (${config.chromium.version})`);
  if (existsSync(path.join(srcDir, '.git'))) {
    // Plain fetch, not a fetch by SHA: not every git host allows fetching an
    // arbitrary object, but every host serves the history the pin lives in.
    run('git', ['-C', srcDir, 'fetch', '--prune', 'origin']);
  }
  const syncArgs = gclientSyncArgs({
    revision: config.chromium.revision,
    withRefs,
    jobs,
  });
  // Streamed, not captured: a sync takes tens of minutes and writes progress
  // the operator wants to see. On Windows this goes through cmd.exe
  // (lib/exec.mjs) because `gclient` is `gclient.bat` there.
  log(`$ gclient ${syncArgs.join(' ')}`);
  const sync = spawnCommand(
    { file: gclientExecutable(depotTools), args: syncArgs, cwd: dest },
    { env },
  );
  if (sync.error !== undefined) {
    throw new Error(`gclient could not be started: ${sync.error.message}`);
  }
  if (sync.status !== 0) {
    throw new Error(`gclient sync exited with code ${sync.status}`);
  }

  const head = run('git', ['-C', srcDir, 'rev-parse', 'HEAD']).trim();
  if (head !== config.chromium.revision) {
    throw new Error(
      `checkout HEAD is ${head} but the pinned revision is ${config.chromium.revision}; refusing to continue`,
    );
  }
  log(`checkout verified at the pinned revision`);

  if (install) {
    installOverlay({ checkoutPath: srcDir, log, config });
  } else {
    log('overlay not installed (pass --install to do so)');
  }

  return { srcDir, head };
}

function recordDepotTools(revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('expected a full 40-character commit SHA');
  }
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  if (config.toolchain?.depotTools === undefined) {
    throw new Error('config has no toolchain.depotTools section');
  }
  config.toolchain.depotTools.revision = revision;
  config.toolchain.depotTools.revisionStatus = 'pinned';
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`recorded depot_tools revision ${revision} in ${path.relative(REPO_ROOT, CONFIG_PATH)}`);
}

function main(argv) {
  const config = loadConfig();
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  if (argv.includes('--record-depot-tools')) {
    const revision = valueOf('--record-depot-tools');
    if (revision === undefined) {
      throw new Error('--record-depot-tools requires a commit SHA');
    }
    recordDepotTools(revision);
    return 0;
  }

  if (argv.includes('--low-resource-experiment')) {
    throw new Error('LOW_RESOURCE_EXPERIMENT is retired; Chromium sync always requires 150 GB free disk');
  }

  const dest = valueOf('--dest') ?? process.env.AURELIA_CHROMIUM_DEST;
  if (dest === undefined) {
    throw new Error('--dest <directory> is required (or set AURELIA_CHROMIUM_DEST)');
  }
  if (argv.includes('--jobs') && valueOf('--jobs') === undefined) {
    throw new Error('--jobs requires a number from 1 through 32');
  }
  const jobs = parseJobs(valueOf('--jobs'));

  if (argv.includes('--check-only')) {
    const preflightResult = preflight({ dest, config });
    for (const report of preflightResult.reports) {
      console.log(`preflight: ${report}`);
    }
    console.log(
      preflightResult.problems.length === 0 ? 'preflight OK' : 'preflight FAILED',
    );
    return preflightResult.problems.length === 0 ? 0 : 1;
  }

  const result = syncCheckout({
    dest,
    install: argv.includes('--install'),
    withRefs: argv.includes('--with-refs'),
    jobs,
    config,
  });
  console.log(`ready: ${result.srcDir} at ${result.head}`);
  return 0;
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

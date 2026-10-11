#!/usr/bin/env node
/**
 * Initialize the Windows Python tools at the *already checked out* depot_tools
 * revision. gclient.bat skips update_depot_tools.bat when DEPOT_TOOLS_UPDATE=0,
 * so a successful sync does not create python3_bin_reldir.txt. gn.bat calls
 * python-bin/python3.bat, which needs that generated pointer and its CIPD Python.
 *
 * bootstrap/win_tools.bat installs the Python version from the checked-out
 * bootstrap/manifest.txt and runs bootstrap/bootstrap.py to write the pointer.
 * Unlike update_depot_tools.bat it never fetches or checks out a Git ref.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from '../lib/entry.mjs';
import { captureCommand, spawnCommand, withPathPrefix } from './lib/exec.mjs';

export function windowsPythonPath(depotTools, { read = readFileSync, exists = existsSync } = {}) {
  const pointer = path.join(depotTools, 'python3_bin_reldir.txt');
  if (!exists(pointer)) {
    throw new Error(`depot_tools bootstrap did not create ${pointer}`);
  }
  const relative = read(pointer, 'utf8').trim();
  // The pointer is generated from bootstrap/manifest.txt. Refuse absolute or
  // escaping paths instead of trusting a stale or corrupted generated file.
  if (!/^bootstrap-[\w.@-]+_bin[\\/]python3[\\/]bin$/.test(relative)) {
    throw new Error(`invalid depot_tools Python pointer in ${pointer}: ${relative}`);
  }
  const python = path.join(depotTools, ...relative.split(/[\\/]/), 'python3.exe');
  if (!exists(python)) {
    throw new Error(`depot_tools bootstrap Python is missing: ${python}`);
  }
  return python;
}

/** Run only the pinned checkout's CIPD Python bootstrap; never its Git updater. */
export function bootstrapWindowsDepotTools({
  depotTools,
  revision,
  env = process.env,
  platform = process.platform,
  capture = captureCommand,
  spawn = spawnCommand,
  exists = existsSync,
  read = readFileSync,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows depot_tools bootstrap requires Windows');
  }
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) {
    throw new Error('a pinned depot_tools commit SHA is required');
  }
  const childEnv = {
    ...withPathPrefix(env, depotTools),
    DEPOT_TOOLS_UPDATE: '0',
    DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
  };
  const assertPin = () => {
    const actual = capture(
      { file: 'git', args: ['-C', depotTools, 'rev-parse', 'HEAD'], cwd: depotTools },
      { env: childEnv },
    ).trim();
    if (actual !== revision) {
      throw new Error(`depot_tools HEAD is ${actual}, expected pinned ${revision}`);
    }
  };
  assertPin();
  const script = path.join(depotTools, 'bootstrap', 'win_tools.bat');
  if (!exists(script)) {
    throw new Error(`pinned depot_tools bootstrap script is missing: ${script}`);
  }
  const result = spawn({ file: script, args: [], cwd: depotTools }, { env: childEnv });
  if (result.error) {
    throw new Error(`depot_tools Python bootstrap could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`depot_tools Python bootstrap exited with code ${result.status}`);
  }
  assertPin();
  return windowsPythonPath(depotTools, { exists, read });
}

if (isMainModule(import.meta.url)) {
  try {
    const [depotTools, revision] = process.argv.slice(2);
    const python = bootstrapWindowsDepotTools({ depotTools, revision });
    console.log(`pinned depot_tools Python ready: ${python}`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

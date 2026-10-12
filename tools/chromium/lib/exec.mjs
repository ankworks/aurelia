#!/usr/bin/env node
/**
 * Child-process invocation that works the same way on Windows and everywhere
 * else.
 *
 * The problem this solves: on Windows the tools this repository drives are not
 * executables but batch files (`gn.bat`, `autoninja.bat`, `gclient.bat`, all
 * shipped by depot_tools). Since Node 18.20 a batch file cannot be spawned
 * directly - `spawnSync` without a shell fails - and `shell: true` combined with
 * an argument array lets Node join the arguments without quoting, which breaks
 * the moment a path contains a space.
 *
 * So on Windows these commands are executed the documented way: build one
 * command line, quote every argument for the Windows command-line parser, and
 * hand the whole line to `cmd.exe /d /s /c "<line>"` with
 * `windowsVerbatimArguments` so Node does not add a second layer of quoting.
 * `cmd.exe` also resolves `gn` to `gn.bat` through `PATHEXT`, which is exactly
 * how a developer shell finds them.
 *
 * On POSIX nothing changes: the executable and argument array are passed
 * straight to `spawnSync`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Build a child environment whose PATH begins with `directories`.
 *
 * Two Windows details make a plain `{...process.env, PATH: ...}` unsafe:
 *
 *  - environment variable names are case-insensitive, and GitHub-hosted
 *    Windows runners spell it `Path`. Spreading `process.env` and then
 *    assigning `PATH` leaves *both* keys in the object, and which spelling
 *    survives libuv's de-duplication of the child environment block is not
 *    deterministic - so a run can silently lose depot_tools from PATH;
 *  - prepending the same directory twice (the driver and the sync tool each
 *    add depot_tools) makes PATH longer without adding anything.
 *
 * Both are handled here: only one PATH key remains, and directories already
 * present are not repeated. Nothing outside the returned object is touched, so
 * the ambient PATH of the machine is never modified.
 *
 * @returns {object} a new environment object; the input is not mutated.
 */
export function withPathPrefix(env, ...directories) {
  const next = { ...env };
  let existing = '';
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() !== 'PATH') {
      continue;
    }
    if (typeof next[key] === 'string' && existing === '') {
      existing = next[key];
    }
    delete next[key];
  }
  const present = new Set(
    existing
      .split(path.delimiter)
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.toLowerCase()),
  );
  const prefix = [];
  for (const directory of directories) {
    if (typeof directory !== 'string' || directory.length === 0) {
      continue;
    }
    // Deliberately case-insensitive: Windows PATH lookups are.
    const key = directory.toLowerCase();
    if (present.has(key)) {
      continue;
    }
    present.add(key);
    prefix.push(directory);
  }
  next.PATH = [...prefix, existing]
    .filter((value) => value.length > 0)
    .join(path.delimiter);
  return next;
}

/** Arguments that are safe to pass through cmd.exe without quoting. */
const SAFE_WINDOWS_ARGUMENT = /^[A-Za-z0-9_@+=:,.\\/-]+$/;

/**
 * Quote one argument for a Windows command line so that both the CRT parser of
 * the target program and `cmd.exe` see the intended value: embedded quotes are
 * backslash-escaped and trailing backslashes are doubled so they cannot escape
 * the closing quote.
 */
export function quoteWindowsArgument(argument) {
  const text = String(argument);
  if (text === '') {
    return '""';
  }
  if (SAFE_WINDOWS_ARGUMENT.test(text)) {
    return text;
  }
  const escaped = text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/** One command line for cmd.exe: file plus quoted arguments. */
export function windowsCommandLine(file, args = []) {
  return [file, ...args].map(quoteWindowsArgument).join(' ');
}

/**
 * Bounded capture limit for piped child output. Deliberately finite: the
 * driver must never grow an in-memory buffer without a ceiling (run
 * 38248455910 died on Node's tiny 1 MiB spawnSync default when one command
 * printed far more than expected). Commands with genuinely huge output must
 * stream to a file instead of being captured.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Decide how a command should be spawned, without spawning it.
 *
 * Exported so the platform behaviour can be unit-tested on a Linux runner: the
 * Windows branch is what the owner's machine uses, and it must not be the part
 * nobody ever looked at.
 *
 * @returns {{file: string, args: string[], options: object, commandLine: string}}
 */
export function resolveSpawn(
  command,
  { platform = process.platform, env = process.env } = {},
) {
  const base = {
    cwd: command.cwd,
    stdio: command.stdio ?? 'inherit',
    env,
    maxBuffer: command.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES,
  };
  if (platform !== 'win32') {
    return {
      file: command.file,
      args: command.args ?? [],
      options: { ...base, shell: false },
      commandLine: [command.file, ...(command.args ?? [])].join(' '),
    };
  }
  const commandLine = windowsCommandLine(command.file, command.args ?? []);
  return {
    file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { ...base, windowsVerbatimArguments: true },
    commandLine,
  };
}

/**
 * Run a command ({file, args, cwd, stdio}) to completion.
 *
 * @returns {{status: number|null, stdout: string|null, stderr: string|null, error: Error|undefined, commandLine: string}}
 */
export function spawnCommand(command, options = {}) {
  const resolved = resolveSpawn(command, options);
  return {
    ...spawnSync(resolved.file, resolved.args, resolved.options),
    commandLine: resolved.commandLine,
  };
}

/**
 * Readable error for a failed child process. `ENOBUFS` gets its own message
 * (and preserves `error.code`) so overflow is classified as a capture problem,
 * never mistaken for a compiler or source failure.
 */
function commandError(
  result,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  { includeStdout = true } = {},
) {
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : (result.stdout?.toString('utf8') ?? '');
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : (result.stderr?.toString('utf8') ?? '');
  if (result.error !== undefined) {
    const error = new Error(
      result.error.code === 'ENOBUFS'
        ? `command output exceeded the ${Math.round(
            maxBufferBytes / (1024 * 1024),
          )} MB capture limit (bounded on purpose): ${result.commandLine}`
        : `command failed: ${result.commandLine}\n${
            stderr.trim() || result.error.message
          }`,
    );
    if (result.error.code !== undefined) {
      error.code = result.error.code;
    }
    return error;
  }
  return new Error(
    `command failed: ${result.commandLine}\n${
      stderr.trim() ||
      (includeStdout ? stdout.trim() : '') ||
      `exit code ${result.status}`
    }`,
  );
}

/**
 * Run a command and return its standard output, throwing a readable error on a
 * non-zero exit - the shape the upstream file fetcher needs.
 *
 * @returns {string}
 */
export function captureCommand(command, options = {}) {
  const result = spawnCommand(
    { ...command, stdio: ['ignore', 'pipe', 'pipe'] },
    options,
  );
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : (result.stdout?.toString('utf8') ?? '');
  if (result.error !== undefined || result.status !== 0) {
    throw commandError(result, command.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES);
  }
  return stdout;
}

/**
 * Run a command and return its standard output as raw bytes.
 *
 * Used where the caller needs the exact bytes (upstream files fetched from a
 * checkout), not a decoded string.
 *
 * @returns {Buffer}
 */
export function captureCommandBuffer(command, options = {}) {
  const result = spawnCommand(
    { ...command, stdio: ['ignore', 'pipe', 'pipe'] },
    options,
  );
  if (result.error !== undefined || result.status !== 0) {
    throw commandError(result, command.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES, {
      includeStdout: false,
    });
  }
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '');
}

export { spawnSync };

/**
 * Build-plan construction for resource-aware targeted compilation (M1.9).
 *
 * Pure planning helpers: they turn the reviewed mode policy into exact Ninja
 * commands, exact Ninja object targets for the Aurelia C++ controllers, and
 * honest classification of build failures and measured resource samples.
 * Nothing here spawns a process or claims a build result; the validation
 * driver executes the planned commands and records their exit codes.
 */
import path from 'node:path';

/**
 * The Aurelia C++ controller translation units compiled by the experimental
 * targeted-lite level. Each entry names the exact GN source_set label it comes
 * from, the source file declared in the overlay BUILD.gn, and the Ninja object
 * target that compiles it (GN's obj/<label-dir>/<label-name>/<source>.obj
 * convention). The driver verifies each object target exists in the generated
 * Ninja graph before compiling and the .obj outputs afterwards, so a PASS
 * claim is tied to concrete outputs, not to a target lookup.
 */
export const TARGETED_LITE_CPP_UNITS = Object.freeze([
  Object.freeze({
    gnLabel: '//chrome/browser/ui/webui/aurelia:aurelia',
    source: 'chrome/browser/ui/webui/aurelia/aurelia_ui.cc',
    object: 'obj/chrome/browser/ui/webui/aurelia/aurelia/aurelia_ui.obj',
  }),
  Object.freeze({
    gnLabel: '//chrome/browser/ui/webui/newtab:newtab',
    source: 'chrome/browser/ui/webui/newtab/newtab_ui.cc',
    object: 'obj/chrome/browser/ui/webui/newtab/newtab/newtab_ui.obj',
  }),
]);

/**
 * Derive the Ninja object target for one source of a GN C++ target.
 *
 * GN writes each compiled source to
 * `obj/<label-dir>/<label-name>/<source-relative-to-BUILD-dir>.obj`, which is
 * the stable, tool-native way to compile a single translation unit without
 * dragging in the target's transitive dependencies. Sources outside the BUILD
 * directory or non-translation units are rejected instead of guessed at.
 */
export function objectTargetFor(gnLabel, sourcePath, pathApi = path) {
  const match = /^\/\/([^:]+):([^:]+)$/.exec(String(gnLabel ?? ''));
  if (match === null) {
    throw new Error(`invalid GN target label: ${JSON.stringify(gnLabel)}`);
  }
  const [, labelDir, labelName] = match;
  const cleaned = String(sourcePath ?? '').split(pathApi.sep).join('/').replace(/^\.\//, '');
  if (cleaned.length === 0) {
    throw new Error(`empty source path for ${gnLabel}`);
  }
  if (!cleaned.startsWith(`${labelDir}/`)) {
    throw new Error(
      `source ${sourcePath} is not under the BUILD directory of ${gnLabel}`,
    );
  }
  const relative = cleaned.slice(labelDir.length + 1);
  if (
    relative.length === 0 ||
    relative.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error(
      `source ${sourcePath} does not map to a stable Ninja object target`,
    );
  }
  if (!/\.(cc|cpp|cxx|c|mm)$/.test(relative)) {
    throw new Error(
      `source ${sourcePath} is not a compilable C/C++ translation unit`,
    );
  }
  return `obj/${labelDir}/${labelName}/${relative.replace(/\.[^.]+$/, '.obj')}`;
}

/** Sanity-check the compiled unit table against the derivation above. */
export function plannedObjectTargets(units = TARGETED_LITE_CPP_UNITS) {
  return units.map((unit) => {
    const derived = objectTargetFor(unit.gnLabel, unit.source);
    if (derived !== unit.object) {
      throw new Error(
        `${unit.gnLabel} ${unit.source}: planned object target ${unit.object} does not match the derived target ${derived}`,
      );
    }
    return { ...unit, object: derived };
  });
}

/**
 * Convert one GN target label into the Ninja target name GN generates for it.
 *
 * Exact pinned behavior (GN cfcd774b, src/gn/ninja_build_writer.cc,
 * `gn help ninja_rules`): "Full label name with no leading slashes. So you can
 * use `ninja tools/fruit:doom_melon` to build `//tools/fruit:doom_melon`."
 * and "For consistency with the rest of the program, GN introspection commands
 * accept explicit labels." So `//a/b:c` is the canonical form for `gn desc` /
 * `gn check`, while the build executor must be given `a/b:c`. Plain Ninja
 * paths (obj/... translation units, `chrome`) pass through unchanged.
 *
 * This is the single conversion point at the build execution boundary; GN
 * validation keeps the canonical `//` form everywhere.
 */
export function ninjaTargetFor(target) {
  const text = String(target ?? '');
  if (text.startsWith('//')) {
    return text.slice(2);
  }
  return text;
}

/**
 * Exact `autoninja` arguments for a bounded compile: job cap first, then the
 * exact Ninja targets (GN labels converted with `ninjaTargetFor`). The out
 * directory must already be the GN-relative path.
 */
export function ninjaBuildArgs({ outDirRelative, jobs, targets }) {
  if (
    !Number.isInteger(jobs) ||
    jobs < 1 ||
    (typeof outDirRelative !== 'string' || outDirRelative.length === 0)
  ) {
    throw new Error(
      `invalid ninja build plan: outDirRelative=${JSON.stringify(outDirRelative)} jobs=${JSON.stringify(jobs)}`,
    );
  }
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.some((target) => typeof target !== 'string' || target.length === 0)
  ) {
    throw new Error('ninja build plan needs at least one concrete target');
  }
  return [
    '-C',
    outDirRelative,
    '-j',
    String(jobs),
    ...targets.map((target) => ninjaTargetFor(target)),
  ];
}

/**
 * Build-backend commands for a Siso-managed Chromium 155 output directory
 * (pinned tools: GN cfcd774b, Siso `build/siso` @ d38036b6 via CIPD
 * `third_party/siso/cipd`, Ninja 1.12.1.chromium.4, depot_tools @ 1e43ae34).
 *
 * A generated out dir is Siso-managed (`out/.siso_deps` exists) because
 * autoninja dispatches every build to `siso ninja --offline`
 * (autoninja.py `_get_use_siso_default`). Keep one consistent backend:
 *
 * - builds run through `autoninja` (→ siso), and
 * - build-graph inspection runs through `siso query ...` on the same pinned
 *   siso binary (subcmd/query @ d38036b6): read-only manifest queries that
 *   fail with `unknown target` / `target not found` for nonexistent targets.
 *
 * Never run plain `ninja` against a Siso-managed out dir: depot_tools/ninja.py
 * exits with its `.siso_deps` guard for every tool outside the read-only
 * allowlist (list/commands/inputs/targets) and `query` is not in that
 * allowlist (observed in run 38218572222). Never delete Siso state files and
 * never `gn clean` to "switch back" — that would destroy the working build.
 */
export const BUILD_BACKEND = Object.freeze({
  buildCommand: 'autoninja',
  queryCommand: 'siso',
});

/**
 * Exact `siso query inputs` arguments: verify one target exists in the
 * generated build graph (siso subcmd/query/inputs.go at the pinned revision:
 * `siso query inputs -C <dir> <targets>` resolves each target through
 * `ninjautil.State.Targets`, which returns `unknown target %q` for paths that
 * are not in the manifest, and `target not found: %q` for unresolvable
 * traversal steps). Read-only: loads `build.ninja`; the `.siso_deps` deps log
 * is only read with `--include_deps`, which we never pass.
 */
export function sisoQueryInputsArgs({ outDirRelative, target }) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('siso query inputs needs a concrete target');
  }
  return ['query', 'inputs', '-C', outDirRelative, ninjaTargetFor(target)];
}

/**
 * Classify a failed build output so the summary can distinguish resource
 * exhaustion from source compilation errors (and from a wrong target name).
 * The run monitor's RESOURCE EXHAUSTED status takes precedence at runtime;
 * this classifies the compiler output of a process that exited non-zero.
 */
export const BUILD_FAILURE_CLASSES = Object.freeze([
  'memory-exhaustion',
  'disk-exhaustion',
  'missing-include',
  'target-resolution',
  'link-error',
  'compiler-error',
  'unclassified',
]);

export function classifyBuildFailure(text) {
  const output = String(text ?? '');
  if (
    /\bC1060\b|\bC1076\b|out of heap space|\bLNK1102\b|out of memory|std::bad_alloc/i.test(
      output,
    )
  ) {
    return 'memory-exhaustion';
  }
  if (
    /no space left on (?:the disk|device)|there is not enough space on the disk|disk is full|disk full/i.test(
      output,
    )
  ) {
    return 'disk-exhaustion';
  }
  if (/C1083: Cannot open include file/i.test(output)) {
    return 'missing-include';
  }
  if (
    /unknown target|target not found|missing and no known rule to make it/i.test(
      output,
    )
  ) {
    return 'target-resolution';
  }
  if (/contains Siso state file/i.test(output)) {
    // depot_tools/ninja.py's .siso_deps guard: a Ninja-direct command was
    // aimed at a Siso-managed out dir (backend mixing). Not a source error.
    return 'backend-mismatch';
  }
  if (/\bLNK\d{3,5}\b/.test(output)) {
    return 'link-error';
  }
  if (/\bfatal error C\d+/i.test(output) || /\berror C\d+/i.test(output)) {
    return 'compiler-error';
  }
  return 'unclassified';
}

/** Compact human duration for stage tables: `45s`, `12m 3s`, `2h 5m`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Peak memory / disk pressure from the resource samples recorded during a
 * stage. Returns null when the stage produced no numeric samples, so a report
 * never invents a measurement.
 */
export function summarizeUsage(samples) {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (sample) => sample !== null && typeof sample === 'object',
  );
  if (list.length === 0) {
    return null;
  }
  let peakUsedMemoryGb = null;
  let minimumAvailableMemoryGb = null;
  let minimumFreeDiskGb = null;
  for (const sample of list) {
    const total = Number(sample.totalMemoryGb);
    const available = Number(sample.availableMemoryGb);
    const free = Number(sample.freeDiskGb ?? sample.destinationFreeDiskGb);
    if (Number.isFinite(total) && Number.isFinite(available)) {
      const used = Math.round((total - available) * 10) / 10;
      if (peakUsedMemoryGb === null || used > peakUsedMemoryGb) {
        peakUsedMemoryGb = used;
      }
      if (minimumAvailableMemoryGb === null || available < minimumAvailableMemoryGb) {
        minimumAvailableMemoryGb = available;
      }
    }
    if (Number.isFinite(free)) {
      if (minimumFreeDiskGb === null || free < minimumFreeDiskGb) {
        minimumFreeDiskGb = free;
      }
    }
  }
  return {
    sampleCount: list.length,
    peakUsedMemoryGb,
    minimumAvailableMemoryGb,
    minimumFreeDiskGb,
  };
}

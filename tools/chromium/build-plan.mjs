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
 * Exact `autoninja` arguments for a bounded compile: job cap first, then the
 * exact targets. The out directory must already be the GN-relative path.
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
  return ['-C', outDirRelative, '-j', String(jobs), ...targets];
}

/** `autoninja -t query` arguments: verify one target exists in the graph. */
export function ninjaQueryArgs({ outDirRelative, target }) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('ninja query needs a concrete target');
  }
  return ['-C', outDirRelative, '-t', 'query', target];
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
  if (/unknown target|missing and no known rule to make it/i.test(output)) {
    return 'target-resolution';
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

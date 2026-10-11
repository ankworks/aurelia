/**
 * Validate targets using GN's full JSON description at the pinned GN revision.
 * Chromium 155's GN does not expose `type` as a standalone `gn desc` field:
 * DescBuilder only emits it when no field is selected. Full `--format=json`
 * includes type, deps and (for actions) declared outputs together.
 *
 * These checks inspect the generated graph. They do not execute actions,
 * compile C++, or replace the scoped `gn check` header dependency checks.
 */
import path from 'node:path';

const resourceTargets = (dir, prefix) => {
  const base = `//chrome/browser/resources/${dir}`;
  const gen = `gen/chrome/browser/resources/${dir}`;
  return [
    {
      label: `${base}:build_ts`,
      type: 'action',
      deps: [`${base}:build_path_map`],
      outputs: [`${gen}/tsconfig_build_ts.json`],
    },
    {
      label: `${base}:build_grd`,
      type: 'action',
      deps: [`${base}:lint`, `${base}:preprocess_static_files`],
      outputs: [`${gen}/resources.grd`],
    },
    {
      label: `${base}:resources`,
      type: 'source_set',
      deps: [`${base}:resources_grit`],
    },
    {
      label: `${base}:resources_grit`,
      type: 'action',
      deps: [`${base}:build_grd`],
      outputs: [
        `gen/chrome/grit/${prefix}_resources.h`,
        `gen/chrome/grit/${prefix}_resources_map.h`,
        `gen/chrome/${prefix}_resources.pak`,
      ],
    },
    {
      label: `//chrome/browser/ui/webui/${dir}:${dir}`,
      type: 'source_set',
      deps: [`${base}:resources`],
    },
  ];
};

// The expected HTML resource is checked separately by the GRIT contract;
// these are GN-declared outputs, not evidence that the files were built.
export const AURELIA_GN_TARGETS = Object.freeze([
  ...resourceTargets('aurelia', 'aurelia'),
  ...resourceTargets('newtab', 'aurelia_newtab'),
]);

/** Use the platform's path API (win32 in Windows CI), never parse a drive by hand. */
export function gnOutputDirectory(srcDir, outDir, pathApi = path) {
  const relative = pathApi.relative(srcDir, outDir);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    throw new Error(
      `GN output directory must be inside the source tree: ${outDir}`,
    );
  }
  return relative;
}

/** GN full descriptions are keyed by the exact label in the default toolchain. */
export function verifyGnDescription(text, spec, outDir) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${spec.label}: invalid GN JSON description: ${error.message}`,
    );
  }
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length !== 1 ||
    !Object.hasOwn(data, spec.label)
  ) {
    throw new Error(
      `${spec.label}: GN did not return exactly the requested target label`,
    );
  }
  const target = data[spec.label];
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`${spec.label}: invalid GN target description`);
  }
  if (target.type !== spec.type) {
    throw new Error(
      `${spec.label}: expected GN type ${spec.type}, got ${JSON.stringify(target.type)}`,
    );
  }
  if (
    !Array.isArray(target.deps) ||
    !target.deps.every((dep) => typeof dep === 'string')
  ) {
    throw new Error(`${spec.label}: missing or invalid GN dependency list`);
  }
  for (const dep of spec.deps ?? []) {
    if (!target.deps.includes(dep)) {
      throw new Error(`${spec.label}: missing direct GN dependency ${dep}`);
    }
  }
  if (spec.outputs) {
    if (
      !Array.isArray(target.outputs) ||
      !target.outputs.every((output) => typeof output === 'string')
    ) {
      throw new Error(`${spec.label}: missing or invalid GN output list`);
    }
    const prefix = `//${outDir.replaceAll('\\', '/')}/`;
    for (const output of spec.outputs) {
      if (!target.outputs.includes(`${prefix}${output}`)) {
        throw new Error(
          `${spec.label}: missing declared GN output ${prefix}${output}`,
        );
      }
    }
  }
  return `${spec.label}: ${target.type}`;
}

/** Pinned `gn check` takes zero or one optional label, never a list of labels. */
export function scopedGnCheckCommands(srcDir, outDir, targets, pathApi = path) {
  const gnOut = gnOutputDirectory(srcDir, outDir, pathApi);
  return targets.map((target) => ({ target, args: ['check', gnOut, target] }));
}

/** runDesc is supplied by the pipeline so command failures always propagate. */
export function verifyGnTargets({
  srcDir,
  outDir,
  runDesc,
  targets = AURELIA_GN_TARGETS,
  pathApi = path,
}) {
  const gnOut = gnOutputDirectory(srcDir, outDir, pathApi);
  return targets.map((spec) => {
    const args = ['desc', gnOut, spec.label, '--format=json'];
    return verifyGnDescription(runDesc(args), spec, gnOut);
  });
}

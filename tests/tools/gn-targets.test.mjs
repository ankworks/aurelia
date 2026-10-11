import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AURELIA_GN_TARGETS,
  gnOutputDirectory,
  scopedGnCheckCommands,
  verifyGnDescription,
  verifyGnTargets,
} from '../../tools/chromium/gn-targets.mjs';
import {
  TARGETED_CPP_TARGETS,
  WEBUI_RESOURCE_TARGETS,
} from '../../tools/chromium/ci-validation.mjs';

// Pinned GN's full `desc --format=json` is keyed by the exact label and
// includes type, deps and declared outputs. A field-filtered `type` request
// does NOT return this structure (and fails for an action).
const action = '//chrome/browser/resources/newtab:build_grd';
const actionSpec = AURELIA_GN_TARGETS.find((spec) => spec.label === action);
const actionDescription = JSON.stringify({
  [action]: {
    type: 'action',
    toolchain: '//build/toolchain/win:win_clang_x64',
    deps: [
      '//chrome/browser/resources/newtab:lint',
      '//chrome/browser/resources/newtab:preprocess_static_files',
      '//chrome/browser/resources/newtab:build_ts',
    ],
    outputs: [
      '//out/Aurelia/gen/chrome/browser/resources/newtab/resources.grd',
    ],
  },
});

describe('pinned GN target verification', () => {
  it('queries the complete JSON description, not the unsupported standalone type field', () => {
    const seen = [];
    const rows = verifyGnTargets({
      srcDir: '/checkout/src',
      outDir: '/checkout/src/out/Aurelia',
      targets: [actionSpec],
      runDesc: (args) => {
        seen.push(args);
        return actionDescription;
      },
    });
    expect(seen).toEqual([['desc', 'out/Aurelia', action, '--format=json']]);
    expect(rows).toEqual([`${action}: action`]);
    expect(AURELIA_GN_TARGETS.map((spec) => spec.label)).toEqual(
      expect.arrayContaining([
        ...WEBUI_RESOURCE_TARGETS,
        ...TARGETED_CPP_TARGETS,
      ]),
    );
    expect(AURELIA_GN_TARGETS).toHaveLength(10); // includes both GRIT actions
  });

  it('rejects absent or mismatched labels, even when GN returned zero successfully', () => {
    for (const text of [
      '{}',
      JSON.stringify({ '//other:target': { type: 'action' } }),
    ]) {
      expect(() =>
        verifyGnDescription(text, actionSpec, 'out/Aurelia'),
      ).toThrow('did not return exactly the requested target label');
    }
    expect(() =>
      verifyGnDescription(
        JSON.stringify({
          [action]: { type: 'action', deps: [] },
          '//other:x': {},
        }),
        actionSpec,
        'out/Aurelia',
      ),
    ).toThrow('did not return exactly the requested target label');
  });

  it('rejects wrong types, unsupported field queries and invalid JSON', () => {
    expect(() =>
      verifyGnDescription(
        actionDescription.replace('"type":"action"', '"type":"group"'),
        actionSpec,
        'out/Aurelia',
      ),
    ).toThrow('expected GN type action, got "group"');
    expect(() =>
      verifyGnDescription('action\n', actionSpec, 'out/Aurelia'),
    ).toThrow('invalid GN JSON description');
    expect(() =>
      verifyGnDescription(
        JSON.stringify({ [action]: { deps: [], outputs: [] } }),
        actionSpec,
        'out/Aurelia',
      ),
    ).toThrow('expected GN type action');
  });

  it('requires direct dependencies and exact declared outputs', () => {
    const data = JSON.parse(actionDescription);
    data[action].deps = [];
    expect(() =>
      verifyGnDescription(JSON.stringify(data), actionSpec, 'out/Aurelia'),
    ).toThrow('missing direct GN dependency');
    data[action].deps = JSON.parse(actionDescription)[action].deps;
    data[action].outputs = [
      '//out/Other/gen/chrome/browser/resources/newtab/resources.grd',
    ];
    expect(() =>
      verifyGnDescription(JSON.stringify(data), actionSpec, 'out/Aurelia'),
    ).toThrow('missing declared GN output //out/Aurelia/');
    delete data[action].outputs;
    expect(() =>
      verifyGnDescription(JSON.stringify(data), actionSpec, 'out/Aurelia'),
    ).toThrow('missing or invalid GN output list');
  });

  it('accepts group targets without outputs while still validating their dependencies', () => {
    const groupSpec = {
      label: '//example:group',
      type: 'group',
      deps: ['//example:action'],
    };
    expect(
      verifyGnDescription(
        JSON.stringify({
          [groupSpec.label]: { type: 'group', deps: ['//example:action'] },
        }),
        groupSpec,
        'out/Aurelia',
      ),
    ).toBe('//example:group: group');
  });

  it('propagates GN command failure instead of treating it as a missing optional field', () => {
    expect(() =>
      verifyGnTargets({
        srcDir: '/checkout/src',
        outDir: '/checkout/src/out/Aurelia',
        targets: [actionSpec],
        runDesc: () => {
          throw new Error('gn exited with code 1');
        },
      }),
    ).toThrow('gn exited with code 1');
  });

  it('handles Windows output paths and rejects a build directory outside the checkout', () => {
    const src = 'C:\\work area\\chromium\\src';
    const out = 'C:\\work area\\chromium\\src\\out\\Aurelia';
    expect(gnOutputDirectory(src, out, path.win32)).toBe('out\\Aurelia');
    expect(
      verifyGnTargets({
        srcDir: src,
        outDir: out,
        pathApi: path.win32,
        targets: [actionSpec],
        runDesc: (args) => {
          expect(args).toEqual([
            'desc',
            'out\\Aurelia',
            action,
            '--format=json',
          ]);
          return actionDescription;
        },
      }),
    ).toEqual([`${action}: action`]);
    expect(() =>
      gnOutputDirectory(src, 'D:\\out\\Aurelia', path.win32),
    ).toThrow('must be inside the source tree');
    expect(() =>
      gnOutputDirectory(src, 'C:\\work area\\chromium\\other', path.win32),
    ).toThrow('must be inside the source tree');
  });

  it('runs scoped GN checks separately for both controller labels', () => {
    expect(
      scopedGnCheckCommands(
        'C:\\chromium\\src',
        'C:\\chromium\\src\\out\\Aurelia',
        TARGETED_CPP_TARGETS,
        path.win32,
      ),
    ).toEqual(
      TARGETED_CPP_TARGETS.map((target) => ({
        target,
        args: ['check', 'out\\Aurelia', target],
      })),
    );
  });
});

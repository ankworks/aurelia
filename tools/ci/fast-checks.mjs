#!/usr/bin/env node
/**
 * Fast, offline, dependency-free repository checks.
 *
 * These run in fast CI on every pull request and are cheap enough to run
 * locally before pushing: `node tools/ci/fast-checks.mjs`.
 *
 * What they protect:
 *  - the Chromium pin stays exact and immutable;
 *  - checked-in generated files match their generator (no drift between the
 *    WebUI overlay and the design-token source of truth);
 *  - the patch set still verifies offline;
 *  - the overlay stays Chromium-native (no Node.js runtime leaks into the
 *    browser, which is a hard product requirement);
 *  - workflows stay pinned and minimally privileged;
 *  - no obvious credential is committed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, loadConfig, overlayDir } from '../chromium/lib/config.mjs';
import { generateVersionHeader } from '../chromium/lib/version-header.mjs';
import { generate as generateTokens } from '../design/generate-tokens.mjs';
import {
  collectOverlayFiles,
  verifyOffline,
} from '../chromium/verify-patches.mjs';
import { gnArgFiles, validateGnArgs } from '../chromium/gn-args.mjs';
import { checkContrast } from '../design/check-contrast.mjs';
import { checkWebUIResources } from './check-webui-resources.mjs';
import { checkDocsLinks } from './check-docs-links.mjs';
import { checkLineEndings } from './check-line-endings.mjs';
import { checkPowerShellScripts } from './check-powershell.mjs';
import { compareWorkflows } from './install-workflows.mjs';
import { checkWorkflows } from './workflow-policy.mjs';
import { scanRepository } from './secret-scan.mjs';
import { isMainModule } from '../lib/entry.mjs';

/** File extensions allowed inside the Chromium overlay. */
export const ALLOWED_OVERLAY_EXTENSIONS = new Set([
  '.cc',
  '.h',
  '.gn',
  '.gni',
  '.html',
  '.css',
  '.ts',
  '.svg',
  '.json',
]);

/** Paths inside the overlay that would mean Node.js leaked into the browser. */
export const FORBIDDEN_OVERLAY_PATHS = [
  'package.json',
  'package-lock.json',
  'node_modules/',
  'tsconfig.json',
];

/** Documentation files the configuration promises exist. */
const REQUIRED_DOCS = [
  'docs/NAMING.md',
  'docs/CHROMIUM-UPSTREAM.md',
  'docs/FORK-DELTA.md',
  'docs/BUILDING-CHROMIUM.md',
  'docs/DNS-POLICY.md',
  'docs/CI-SECURITY.md',
  'docs/NETWORK-CONNECTIONS.md',
  'docs/THREAT-MODEL.md',
  'docs/SYNC-ARCHITECTURE.md',
  'docs/TESTING.md',
  'docs/LOCAL-WINDOWS-BUILD.md',
];

export function runFastChecks({ log = console.log } = {}) {
  const checks = [];
  const record = (name, ok, details = '') => {
    checks.push({ name, ok, details });
    log(
      `${ok ? 'PASS' : 'FAIL'}  ${name}${details === '' ? '' : `\n        ${details}`}`,
    );
  };

  let config = null;
  try {
    config = loadConfig();
    record(
      'Chromium pin configuration is valid',
      true,
      `${config.chromium.version} @ ${config.chromium.revision.slice(0, 12)}`,
    );
  } catch (error) {
    record('Chromium pin configuration is valid', false, error.message);
  }

  if (config !== null) {
    try {
      generateVersionHeader({ check: true, config });
      record(
        'generated version header is up to date',
        true,
        'chromium/overlay/.../aurelia_version.h',
      );
    } catch (error) {
      record('generated version header is up to date', false, error.message);
    }

    try {
      generateTokens({ check: true, log: () => {} });
      record(
        'generated design tokens are up to date',
        true,
        'tokens.json -> overlay + packages',
      );
    } catch (error) {
      record('generated design tokens are up to date', false, error.message);
    }

    const verification = verifyOffline(config);
    record(
      'patch set verifies offline',
      verification.ok,
      verification.ok
        ? `${verification.checks.length} checks passed`
        : verification.checks
            .filter((check) => !check.ok)
            .map((check) => `${check.name}: ${check.details}`)
            .join('; '),
    );

    // A Windows checkout (core.autocrlf=true) rewrites text files to CRLF unless
    // .gitattributes says otherwise. The patch files are SHA-256 verified, so
    // fast CI - which runs on Linux, where the bug is invisible - checks the
    // policy that protects them. See tools/ci/check-line-endings.mjs.
    const lineEndings = checkLineEndings({ config });
    record(
      'patch files are protected from line-ending conversion',
      lineEndings.ok,
      lineEndings.ok
        ? `${lineEndings.checked} patch file(s) pinned to LF by ${lineEndings.attributesFile}`
        : lineEndings.problems.join('; '),
    );

    const overlayFiles = collectOverlayFiles(overlayDir(config));
    const badExtensions = overlayFiles.filter((file) => {
      const extension = path.extname(file.path);
      return (
        !ALLOWED_OVERLAY_EXTENSIONS.has(extension) &&
        !file.path.endsWith('.gitkeep')
      );
    });
    record(
      'overlay contains only Chromium-native file types',
      badExtensions.length === 0,
      badExtensions.length === 0
        ? `${overlayFiles.length} file(s)`
        : badExtensions.map((file) => file.path).join(', '),
    );

    const leaked = overlayFiles.filter((file) =>
      FORBIDDEN_OVERLAY_PATHS.some((forbidden) =>
        file.path.endsWith(forbidden),
      ),
    );
    record(
      'no Node.js runtime files inside the Chromium overlay',
      leaked.length === 0,
      leaked.length === 0 ? 'ok' : leaked.map((file) => file.path).join(', '),
    );

    const missingDocs = REQUIRED_DOCS.filter(
      (doc) => !existsSync(path.join(REPO_ROOT, doc)),
    );
    record(
      'documented architecture files exist',
      missingDocs.length === 0,
      missingDocs.length === 0
        ? `${REQUIRED_DOCS.length} document(s)`
        : missingDocs.join(', '),
    );
  }

  const webui = checkWebUIResources();
  record(
    'static GN/GRIT/WebUI consistency (not a build)',
    webui.ok,
    webui.problems.join('; '),
  );

  const contrast = checkContrast();
  record(
    'design tokens meet WCAG 2.1 AA contrast',
    contrast.ok,
    contrast.ok
      ? `${contrast.results.length} pair(s) checked`
      : contrast.problems.join('; '),
  );

  // The reviewed GN arguments are an artefact like any other: every key must be
  // in the allowlist and every value in its allowed set, or the build would be
  // configuring something nobody reviewed.
  const gnFiles = gnArgFiles();
  const gnProblems = gnFiles.flatMap((file) =>
    validateGnArgs(readFileSync(file, 'utf8')).problems.map(
      (problem) => `${path.relative(REPO_ROOT, file)}: ${problem}`,
    ),
  );
  record(
    'GN argument files pass the reviewed policy',
    gnProblems.length === 0,
    gnProblems.length === 0
      ? `${gnFiles.length} configuration file(s)`
      : gnProblems.join('; '),
  );

  const workflowPolicy = checkWorkflows();
  record(
    'workflow supply-chain policy',
    workflowPolicy.problems.length === 0,
    workflowPolicy.problems.length === 0
      ? `${workflowPolicy.workflowCount} workflow(s)`
      : workflowPolicy.problems.join('; '),
  );

  // Once the definitions have been deployed (see docs/CI-SECURITY.md), the
  // installed copies must stay byte-identical to tools/ci/workflows/. Before
  // deployment the check is skipped: there is nothing to compare, and the
  // canonical files are validated by the policy check above either way.
  const installedWorkflowsDir = path.join(REPO_ROOT, '.github/workflows');
  if (existsSync(installedWorkflowsDir)) {
    const deployed = compareWorkflows();
    const drifted = [...deployed.missing, ...deployed.different];
    record(
      'installed workflows match the canonical definitions',
      drifted.length === 0,
      drifted.length === 0
        ? `${deployed.workflows.length} file(s) byte-identical`
        : `run node tools/ci/install-workflows.mjs (${drifted.join(', ')})`,
    );
  }

  // Windows PowerShell cannot run on the CI runner, so the bootstrap script is
  // linted structurally instead (see tools/ci/check-powershell.mjs).
  const powerShell = checkPowerShellScripts();
  record(
    'PowerShell scripts are structurally sound',
    powerShell.ok,
    powerShell.ok
      ? `${powerShell.files.length} script(s)`
      : powerShell.problems.join('; '),
  );

  const docLinks = checkDocsLinks();
  record(
    'internal documentation links resolve',
    docLinks.ok,
    docLinks.ok
      ? `${docLinks.checked} link(s) checked`
      : docLinks.problems.join('; '),
  );

  const findings = scanRepository();
  record(
    'no credentials detected in tracked files',
    findings.length === 0,
    findings.length === 0
      ? 'secret scan clean'
      : findings
          .map((finding) => `${finding.path} [${finding.pattern}]`)
          .join('; '),
  );

  return { ok: checks.every((check) => check.ok), checks };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const result = runFastChecks();
  console.log('');
  console.log(result.ok ? 'FAST CHECKS PASSED' : 'FAST CHECKS FAILED');
  process.exitCode = result.ok ? 0 : 1;
}

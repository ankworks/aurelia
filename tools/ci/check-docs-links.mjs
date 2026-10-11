#!/usr/bin/env node
/**
 * Internal documentation link check.
 *
 * Documentation drift is a quiet failure: a renamed file leaves a link that
 * reads fine and goes nowhere, and the reader trusts it less every time. This
 * checks every relative link and heading anchor in the repository's markdown
 * with no network access - external URLs are listed as "not checked" instead of
 * being fetched (a CI job must not depend on the availability of other sites).
 *
 * Usage:
 *   node tools/ci/check-docs-links.mjs
 *   node tools/ci/check-docs-links.mjs --json
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/entry.mjs';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'build']);

/** Every markdown file, excluding generated and vendored trees. */
export function markdownFiles(root = REPO_ROOT, out = []) {
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue;
    }
    const full = path.join(root, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      markdownFiles(full, out);
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** GitHub's heading slug rules, near enough for our own documents. */
export function slugify(heading) {
  return heading
    .trim()
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/** Headings declared in a markdown file, slugified. */
export function headings(text) {
  const slugs = new Set();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match !== null) {
      slugs.add(slugify(match[1]));
    }
  }
  return slugs;
}

/** Links found in a markdown file: {target, line}. */
export function linksIn(text) {
  const links = [];
  let inFence = false;
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      return;
    }
    const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      links.push({ target: match[1], line: index + 1 });
    }
  });
  return links;
}

/**
 * @returns {{ok: boolean, checked: number, external: number, problems: string[]}}
 */
export function checkDocsLinks({ root = REPO_ROOT } = {}) {
  const problems = [];
  let checked = 0;
  let external = 0;

  for (const file of markdownFiles(root)) {
    const relativeFile = path.relative(root, file);
    const text = readFileSync(file, 'utf8');
    for (const { target, line } of linksIn(text)) {
      if (/^[a-z]+:/i.test(target)) {
        external += 1;
        continue;
      }
      const [rawTargetPath, anchor] = target.split('#');
      let targetPath = rawTargetPath;
      try {
        targetPath = decodeURIComponent(rawTargetPath);
      } catch {
        targetPath = rawTargetPath;
      }
      // A pure-anchor link points into the file it appears in.
      const base =
        targetPath === ''
          ? file
          : targetPath.startsWith('/')
            ? path.join(root, targetPath)
            : path.resolve(
                path.dirname(file),
                targetPath === '' ? '.' : targetPath,
              );
      const isDirectory = targetPath.endsWith('/');
      let resolved = base;
      if (isDirectory) {
        resolved = path.join(base, 'README.md');
      }
      let exists = false;
      try {
        exists = statSync(resolved).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        problems.push(
          `${relativeFile}:${line}: link target does not exist: ${target}`,
        );
        continue;
      }
      checked += 1;
      if (anchor !== undefined && anchor.length > 0) {
        const slugs = headings(readFileSync(resolved, 'utf8'));
        if (!slugs.has(slugify(anchor))) {
          problems.push(
            `${relativeFile}:${line}: anchor not found in ${path.relative(root, resolved)}: #${anchor}`,
          );
        }
      }
    }
  }

  return { ok: problems.length === 0, checked, external, problems };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const result = checkDocsLinks();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const problem of result.problems) {
      console.error(`problem: ${problem}`);
    }
    console.log(
      `${result.checked} internal link(s) checked, ${result.external} external link(s) not checked, ${result.problems.length} problem(s)`,
    );
    console.log(result.ok ? 'DOC LINKS OK' : 'DOC LINK CHECK FAILED');
  }
  process.exitCode = result.ok ? 0 : 1;
}

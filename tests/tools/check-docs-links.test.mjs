import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  checkDocsLinks,
  headings,
  linksIn,
  slugify,
} from '../../tools/ci/check-docs-links.mjs';

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'aurelia-docs-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('internal documentation links', () => {
  it('finds links but ignores code fences and external URLs', () => {
    const links = linksIn(
      [
        '# Title',
        '[guide](docs/GUIDE.md)',
        '```md',
        '[not a link](missing.md)',
        '```',
        '[website](https://example.com)',
      ].join('\n'),
    );
    expect(links).toEqual([
      { target: 'docs/GUIDE.md', line: 2 },
      { target: 'https://example.com', line: 6 },
    ]);
  });

  it('slugifies headings the way GitHub does', () => {
    expect(slugify('## Build state ladder (never collapse these)')).toBe(
      'build-state-ladder-never-collapse-these',
    );
    expect(slugify('### 6. Privacy and network tests (planned, M3)')).toBe(
      '6-privacy-and-network-tests-planned-m3',
    );
  });

  it('ignores headings inside code fences', () => {
    const slugs = headings(['# Real', '```', '# Faked', '```'].join('\n'));
    expect(slugs.has('real')).toBe(true);
    expect(slugs.has('faked')).toBe(false);
  });

  it('accepts a tree whose links and anchors resolve', () => {
    const root = fixture({
      'README.md': '# Home\n\nSee [the guide](docs/GUIDE.md#details).\n',
      'docs/GUIDE.md': '# Guide\n\n## Details\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('reports a missing file with file and line', () => {
    const root = fixture({
      'README.md': '# Home\n\nSee [the guide](docs/MISSING.md).\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/README\.md:3/);
    expect(result.problems[0]).toMatch(/docs\/MISSING\.md/);
  });

  it('reports a missing anchor in an existing file', () => {
    const root = fixture({
      'README.md': '# Home\n\nSee [bit](docs/GUIDE.md#not-there).\n',
      'docs/GUIDE.md': '# Guide\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/anchor not found/);
  });

  it('resolves pure-anchor links inside the same file', () => {
    const root = fixture({
      'README.md': '# Home\n\nJump to [Status](#status).\n\n## Status\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.problems).toEqual([]);
  });

  it('resolves URL-encoded relative links to filenames containing spaces', () => {
    const root = fixture({
      'docs/update/UPDATE 01.md': '# Update 01\n\n## Overview\n',
      'docs/update/UPDATE 02.md':
        '# Update 02\n\nSee [Update 01](./UPDATE%2001.md#overview).\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('counts external links without fetching them', () => {
    const root = fixture({
      'README.md': '# Home\n\n[site](https://example.com/a#b)\n',
    });
    const result = checkDocsLinks({ root });
    expect(result.external).toBe(1);
    expect(result.checked).toBe(0);
  });

  it('checks the real repository', () => {
    const result = checkDocsLinks();
    expect(result.checked).toBeGreaterThan(50);
    expect(result.problems).toEqual([]);
  });
});

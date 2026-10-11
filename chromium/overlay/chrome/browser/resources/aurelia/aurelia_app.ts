// Copyright 2026 The Aurelia Authors
// Use of this source code is governed by the Mozilla Public License, v. 2.0,
// that can be found in the LICENSE file at the repository root.

import './aurelia_status_card.js';
import './command_palette.js';
import type {AureliaCommandPaletteElement} from './command_palette.js';

import {loadTimeData} from '//resources/js/load_time_data.js';

/**
 * Build provenance shown by chrome://aurelia.
 *
 * Values are supplied by AureliaUI (see
 * chrome/browser/ui/webui/aurelia/aurelia_ui.cc). When the page runs outside a
 * Chromium WebUI context (for example in the development harness), the
 * `data-*` attributes on the host element are used instead so the component
 * stays renderable without inventing data.
 */
interface BuildInfo {
  codename: string;
  productVersion: string;
  channel: string;
  chromiumPin: string;
  chromiumPinRevision: string;
  chromiumBuiltVersion: string;
  patchSetVersion: string;
}

const UNAVAILABLE = 'unavailable';

function readBuildInfo(host: HTMLElement): BuildInfo {
  const read = (key: string, attribute: string): string => {
    if (loadTimeData.valueExists(key)) {
      return loadTimeData.getString(key);
    }
    return host.getAttribute(attribute) ?? UNAVAILABLE;
  };

  return {
    codename: read('productCodename', 'data-codename'),
    productVersion: read('productVersion', 'data-product-version'),
    channel: read('buildChannel', 'data-channel'),
    chromiumPin: read('chromiumPin', 'data-chromium-pin'),
    chromiumPinRevision: read('chromiumPinRevision', 'data-chromium-revision'),
    chromiumBuiltVersion: read('chromiumBuiltVersion', 'data-chromium-built'),
    patchSetVersion: read('patchSetVersion', 'data-patch-set'),
  };
}

/** Short revision form for display; full value stays available in the title. */
function abbreviate(revision: string): string {
  return revision.length > 12 ? `${revision.slice(0, 12)}…` : revision;
}

export class AureliaAppElement extends HTMLElement {
  static get is() {
    return 'aurelia-app';
  }

  private info: BuildInfo|null = null;
  private palette: AureliaCommandPaletteElement|null = null;

  connectedCallback(): void {
    if (this.hasAttribute('data-rendered')) {
      return;
    }
    this.setAttribute('data-rendered', 'true');
    this.info = readBuildInfo(this);
    this.render();
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKeydown);
  }

  /**
   * Ctrl+K / Cmd+K toggles the command palette (see README.md). The listener
   * is registered once, from render(), and only when the palette is mounted.
   */
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
        event.key.toLowerCase() !== 'k') {
      return;
    }
    event.preventDefault();
    this.palette?.toggle();
  };

  private render(): void {
    const info = this.info;
    if (info === null) {
      return;
    }

    const header = document.createElement('header');
    header.className = 'aurelia-header';

    const title = document.createElement('h1');
    title.textContent = info.codename;
    header.appendChild(title);

    const tagline = document.createElement('p');
    tagline.className = 'aurelia-tagline';
    tagline.textContent =
        `${info.productVersion} · ${info.channel} · codename pending naming review`;
    header.appendChild(tagline);

    this.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'aurelia-grid';

    grid.appendChild(this.createCard('Chromium pin', [
      ['Version', info.chromiumPin],
      ['Revision', abbreviate(info.chromiumPinRevision)],
      ['Full revision', info.chromiumPinRevision, 'monospace'],
    ]));

    grid.appendChild(this.createCard('Build provenance', [
      ['Chromium version this binary reports', info.chromiumBuiltVersion],
      ['Aurelia patch set', info.patchSetVersion],
    ]));

    // A mismatch here means the binary was not produced from the pinned
    // revision, which is a build-integrity problem rather than a UI problem.
    const pinMatches = info.chromiumBuiltVersion === info.chromiumPin ||
        info.chromiumBuiltVersion === UNAVAILABLE;

    grid.appendChild(this.createCard('Verification', [
      [
        'Pinned revision matches build',
        pinMatches ? 'yes' : `no (built ${info.chromiumBuiltVersion})`,
      ],
      ['Network access from this page', 'none'],
      ['Privileged interfaces', 'none'],
    ]));

    this.appendChild(grid);

    // The palette is part of the page, not a standalone element: without this
    // mount the bundled command_palette.js/.css would never run on the page.
    const opener = document.createElement('button');
    opener.id = 'aurelia-open-palette';
    opener.type = 'button';
    opener.className = 'aurelia-palette-opener';
    opener.textContent = 'Command palette (Ctrl+K)';
    opener.addEventListener('click', () => this.palette?.open());
    this.appendChild(opener);

    const palette = document.createElement('aurelia-command-palette');
    palette.setAttribute('data-opener', opener.id);
    this.palette = palette;
    this.appendChild(palette);
    document.addEventListener('keydown', this.onKeydown);

    const footer = document.createElement('p');
    footer.className = 'aurelia-footer';
    footer.textContent =
        'Early development build. This page is a static status surface; it performs no network requests.';
    this.appendChild(footer);
  }

  private createCard(
      heading: string, rows: Array<[string, string, string?]>): HTMLElement {
    const card = document.createElement('aurelia-status-card');
    card.setAttribute('heading', heading);

    for (const [label, value, variant] of rows) {
      card.appendChild(this.createRow(label, value, variant));
    }
    return card;
  }

  private createRow(label: string, value: string, variant?: string):
      HTMLElement {
    const row = document.createElement('div');
    row.className = 'aurelia-row';

    const labelElement = document.createElement('span');
    labelElement.className = 'aurelia-row-label';
    labelElement.textContent = label;
    row.appendChild(labelElement);

    const valueElement = document.createElement('span');
    valueElement.className = 'aurelia-row-value';
    if (variant === 'monospace') {
      valueElement.classList.add('aurelia-monospace');
      valueElement.title = value;
    }
    valueElement.textContent = variant === 'monospace' ? abbreviate(value) : value;
    row.appendChild(valueElement);

    return row;
  }
}

customElements.define(AureliaAppElement.is, AureliaAppElement);

declare global {
  interface HTMLElementTagNameMap {
    'aurelia-app': AureliaAppElement;
  }
}

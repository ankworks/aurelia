#!/usr/bin/env node
/** Static consistency checks, NOT gn gen, a Chromium build or a runtime test.
 * Contract reviewed against build_webui.gni/grit_rule.gni at the pinned SHA.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../chromium/lib/config.mjs';
import { UPSTREAM_EDITS } from '../chromium/lib/upstream-edits.mjs';
import { isMainModule } from '../lib/entry.mjs';

export function checkWebUIResources({
  read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8'),
  edits = UPSTREAM_EDITS,
} = {}) {
  const problems = [];
  const require = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const overlay = 'chromium/overlay/';
  const replacements = (file) =>
    edits
      .filter((edit) => edit.path === file)
      .map((edit) => edit.replace)
      .join('\n');
  for (const [dir, prefix, controller, map, host, html] of [
    [
      'aurelia',
      'aurelia',
      'AureliaUI',
      'kAureliaResources',
      'kChromeUIAureliaHost',
      'aurelia.html',
    ],
    [
      'newtab',
      'aurelia_newtab',
      'AureliaNewTabUI',
      'kAureliaNewtabResources',
      'kChromeUINewTabAureliaHost',
      'newtab.html',
    ],
  ]) {
    const resources = `chrome/browser/resources/${dir}`;
    const webui = `chrome/browser/ui/webui/${dir}`;
    const gn = read(`${overlay}${resources}/BUILD.gn`);
    require(gn.includes(
      'import("//ui/webui/resources/tools/build_webui.gni")',
    ), `${dir}: use the pinned build_webui template`);
    require(gn.includes('build_webui("build")') &&
      gn.includes(
        `grd_prefix = "${prefix}"`,
      ), `${dir}: wrong resource target/prefix`);
    require(!/\bcss_files\s*=/.test(
      gn,
    ), `${dir}: linked CSS must be static_files, not CSS wrappers`);
    const list = (key) =>
      [
        ...(
          new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(gn)?.[1] ?? ''
        ).matchAll(/"([^"]+)"/g),
      ].map((match) => match[1]);
    const staticFiles = list('static_files');
    const tsFiles = list('ts_files');
    // At the Chromium 155 pin, build_webui.gni only consumes
    // invoker.webui_context_type inside if (defined(invoker.ts_deps)). Without
    // ts_deps GN rejects the assignment before any resource target is built.
    // The dependency also generates trusted chrome:// TypeScript path mappings;
    // it does not change the controller's runtime origin or CSP.
    require(list('ts_deps').includes('//ui/webui/resources/js:build_ts') &&
      /\bwebui_context_type\s*=\s*"trusted"/.test(
        gn,
      ), `${dir}: trusted WebUI TypeScript mapping requires ts_deps`);
    require(staticFiles.includes(html) &&
      tsFiles.length > 0, `${dir}: missing HTML/TypeScript input`);
    for (const file of [...staticFiles, ...tsFiles]) {
      try {
        require(read(`${overlay}${resources}/${file}`).length >
          0, `${dir}: empty input ${file}`);
      } catch {
        problems.push(`${dir}: missing input ${file}`);
      }
    }
    const urls = [
      ...read(`${overlay}${resources}/${html}`).matchAll(
        /(?:src|href)="([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    const outputs = new Set([
      ...staticFiles,
      ...tsFiles.map((file) => file.replace(/\.ts$/, '.js')),
    ]);
    for (const url of urls)
      require(outputs.has(
        url,
      ), `${dir}: HTML resource not generated locally: ${url}`);

    const cpp = read(`${overlay}${webui}/${dir}_ui.cc`);
    const header = read(`${overlay}${webui}/${dir}_ui.h`);
    const target = read(`${overlay}${webui}/BUILD.gn`);
    require(target.includes(`source_set("${dir}")`) &&
      target.includes(
        `"//${resources}:resources"`,
      ), `${dir}: missing controller/resource dependency`);
    for (const suffix of ['', '_map'])
      require(cpp.includes(
        `"chrome/grit/${prefix}_resources${suffix}.h"`,
      ), `${dir}: GRIT include does not match generated prefix`);
    const id = `IDR_${prefix.toUpperCase()}_${html.toUpperCase().replaceAll('.', '_')}`;
    require(cpp.includes(`webui::SetupWebUIDataSource(source, ${map},`) &&
      cpp.includes(id), `${dir}: wrong resource map/default ID`);
    require(cpp.includes(
      `profile, chrome::${host}`,
    ), `${dir}: data source host mismatch`);
    require(header.includes(`DefaultInternalWebUIConfig<${controller}>`) &&
      header.includes(
        `DefaultInternalWebUIConfig(chrome::${host})`,
      ), `${dir}: config/controller mismatch`);
    const registry = replacements(
      'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    );
    require(registry.includes(`"${webui}/${dir}_ui.h"`) &&
      registry.includes(
        `std::make_unique<${controller}Config>()`,
      ), `${dir}: controller not registered`);
    for (const file of [
      'chrome/browser/BUILD.gn',
      'chrome/browser/ui/BUILD.gn',
      'chrome/browser/ui/webui/BUILD.gn',
    ]) {
      require(replacements(file).includes(
        `"//${webui}"`,
      ), `${dir}: missing link dependency in ${file}`);
    }
    require(replacements('chrome/browser/resources/BUILD.gn').includes(
      `"${dir}:resources"`,
    ), `${dir}: resource group dependency missing`);
    const pak = replacements('chrome/chrome_paks.gni');
    require(pak.includes(`"$root_gen_dir/chrome/${prefix}_resources.pak"`) &&
      pak.includes(
        `"//${resources}:resources"`,
      ), `${dir}: resource pak not repacked`);
    require(replacements('tools/gritsettings/resource_ids.spec').includes(
      `${resources}/resources.grd`,
    ), `${dir}: generated GRD has no resource ID allocation`);
  }
  require(replacements('chrome/common/webui_url_constants.h').includes(
    'kChromeUINewTabAureliaHost[] = "aurelia-newtab"',
  ), 'isolated New Tab host is missing');
  require(!read(
    `${overlay}chrome/browser/ui/webui/newtab/newtab_ui.h`,
  ).includes(
    'class NewTabUI',
  ), 'NewTabUI collides with the upstream incognito controller');
  return { ok: problems.length === 0, problems };
}

if (isMainModule(import.meta.url)) {
  const result = checkWebUIResources();
  console.log(
    result.ok
      ? 'PASS  static GN/GRIT/WebUI consistency (not a Chromium build)'
      : result.problems.join('\n'),
  );
  process.exitCode = result.ok ? 0 : 1;
}

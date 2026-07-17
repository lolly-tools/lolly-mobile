// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile export override.
 *
 * The web export API delivers a finished file with `URL.createObjectURL(blob)` +
 * an `<a download>` click (see shells/web/src/bridge/export.js `download`). A
 * browser turns that into a download; the Android WebView has no download handler,
 * so the click is silently dropped — every export/download on mobile no-ops.
 *
 * So we wrap the web ExportAPI and replace ONLY `download`/`file` (the delivery
 * verbs) with a real save via tauri-plugin-fs. `render()` and everything else are
 * inherited unchanged — the rasteriser is identical. Files land in the device's
 * Downloads (a "Lolly" subfolder) — which on Android is the APP-PRIVATE external
 * files dir, invisible to most users — so after saving we hand the file to the OS
 * share sheet via the `LollyShare` JS interface MainActivity registers
 * (ACTION_SEND + FileProvider). No interface (iOS, older builds) → the original
 * saved-toast behaviour.
 */
import { createExportAPI as createWebExportAPI } from '../../web/src/bridge/export.ts';
import { writeFile, mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';

// This override REPLACES the whole web export module for every importer inside
// bridge/, not just for the bridge index — so it must carry that module's full
// public surface, or a sibling importing one of its other exports fails the build
// (export-pptx.ts pulls rasterizeNodeToDataUrl, _host, pureRotationDeg, …).
// The star re-export forwards LIVE bindings, which `_host` (an `export let` the
// web createExportAPI assigns) depends on; our local createExportAPI below
// shadows the starred one per ES module semantics.
export * from '../../web/src/bridge/export.ts';

const SUBDIR = 'Lolly';

// Keep only filesystem-safe characters; never let a tool-supplied name traverse.
const sanitize = (name) => (String(name || 'lolly-export').replace(/[^\w.\- ]+/g, '_') || 'lolly-export');

function toast(message, isError) {
  try {
    const t = document.createElement('div');
    t.textContent = message;
    t.style.cssText =
      'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'z-index:2147483647;padding:12px 18px;border-radius:12px;max-width:90vw;text-align:center;' +
      'font:14px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);' +
      (isError ? 'background:#7a1f1f;color:#fff' : 'background:#0c322c;color:#eafff4');
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 2800);
  } catch { /* no DOM — nothing to show */ }
}

/** Offer the OS share sheet for a just-saved export. Returns true when the native
 *  bridge accepted (chooser opening); false = no bridge or share failed, caller toasts. */
function shareSheet(relPath, mime, title) {
  try {
    const bridge = typeof window !== 'undefined' ? window.LollyShare : null;
    if (!bridge || typeof bridge.shareFile !== 'function') return false;
    return bridge.shareFile(relPath, String(mime || ''), String(title || '')) === true;
  } catch {
    return false;
  }
}

async function saveToDownloads(blob, filename, host) {
  const name = sanitize(filename);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    if (!(await exists(SUBDIR, { baseDir: BaseDirectory.Download }))) {
      await mkdir(SUBDIR, { baseDir: BaseDirectory.Download, recursive: true });
    }
    await writeFile(`${SUBDIR}/${name}`, bytes, { baseDir: BaseDirectory.Download });
    host?.log?.('info', `Saved ${name} to Downloads/${SUBDIR}`);
    if (shareSheet(`${SUBDIR}/${name}`, blob.type, name)) {
      toast(`Saved “${name}” — choose where to send it`);
    } else {
      toast(`Saved “${name}” to Downloads/${SUBDIR}`);
    }
  } catch (err) {
    host?.log?.('error', 'Mobile export save failed', { error: String(err) });
    toast(`Couldn't save “${name}”: ${err?.message || err}`, true);
    throw err;
  }
}

export function createExportAPI(host) {
  const web = createWebExportAPI(host);
  return {
    ...web,
    async download(blob, filename) { await saveToDownloads(blob, filename, host); },
    async file(blob, opts = {}) { await saveToDownloads(blob, opts.filename || 'file', host); },
  };
}

// SPDX-License-Identifier: MPL-2.0
/**
 * Mobile export override.
 *
 * The web export API delivers a finished file with `URL.createObjectURL(blob)` +
 * an `<a download>` click (see shells/web/src/bridge/export.ts `download`). A
 * browser turns that into a download; the Android WebView has no download handler,
 * so the click is silently dropped - every export/download on mobile no-ops.
 *
 * So we wrap the web ExportAPI and replace ONLY `download`/`file` (the delivery
 * verbs) with a real save via tauri-plugin-fs. `render()` and everything else are
 * inherited unchanged - the rasteriser is identical. Files land in the device's
 * Downloads (a "Lolly" subfolder) - which on Android is the APP-PRIVATE external
 * files dir, invisible to most users - so after saving we hand the file to the OS
 * share sheet via the `LollyShare` JS interface MainActivity registers
 * (ACTION_SEND + FileProvider). No interface (iOS, older builds) → the original
 * saved-toast behaviour.
 */
import { createExportAPI as createWebExportAPI } from '../../web/src/bridge/export.ts';
import { writeFile, mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';

// This override REPLACES the whole web export module for every importer inside
// bridge/, not just for the bridge index - so it must carry that module's full
// public surface, or a sibling importing one of its other exports fails the build
// (export-pptx.ts pulls rasterizeNodeToDataUrl, _host, pureRotationDeg, …).
// The star re-export forwards LIVE bindings, which `_host` (an `export let` the
// web createExportAPI assigns) depends on; our local createExportAPI below
// shadows the starred one per ES module semantics.
export * from '../../web/src/bridge/export.ts';

/**
 * The host and the API shape are DERIVED from the web factory this override wraps,
 * rather than restated. The override must remain substitutable for the web module
 * (the resolveId plugin swaps it in for every importer inside bridge/), so a change
 * to the web signature has to fail here at typecheck instead of at runtime in a
 * webview. `WebHost` itself is not exported by the web module, hence Parameters<>.
 */
type ExportHost = Parameters<typeof createWebExportAPI>[0];
type WebExportAPI = ReturnType<typeof createWebExportAPI>;

/**
 * The `ACTION_SEND` bridge MainActivity registers on the Android WebView via
 * `addJavascriptInterface`. Absent on iOS and on older builds, so every call site
 * must feature-detect - see shareSheet below.
 */
interface LollyShareBridge {
  shareFile(relPath: string, mime: string, title: string): boolean;
}
declare global {
  interface Window {
    LollyShare?: LollyShareBridge;
  }
}

const SUBDIR = 'Lolly';

// Keep only filesystem-safe characters; never let a tool-supplied name traverse.
const sanitize = (name: string | undefined): string =>
  String(name || 'lolly-export').replace(/[^\w.\- ]+/g, '_') || 'lolly-export';

function toast(message: string, isError?: boolean): void {
  try {
    const t = document.createElement('div');
    t.textContent = message;
    t.style.cssText =
      'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'z-index:2147483647;padding:12px 18px;border-radius:12px;max-width:90vw;text-align:center;' +
      'font:14px/1.35 SUSE,system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);' +
      (isError ? 'background:#7a1f1f;color:#fff' : 'background:#0c322c;color:#eafff4');
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 2800);
  } catch { /* no DOM - nothing to show */ }
}

/** Offer the OS share sheet for a just-saved export. Returns true when the native
 *  bridge accepted (chooser opening); false = no bridge or share failed, caller toasts. */
function shareSheet(relPath: string, mime: string, title: string): boolean {
  try {
    const bridge = typeof window !== 'undefined' ? window.LollyShare : null;
    if (!bridge || typeof bridge.shareFile !== 'function') return false;
    return bridge.shareFile(relPath, String(mime || ''), String(title || '')) === true;
  } catch {
    return false;
  }
}

async function saveToDownloads(blob: Blob, filename: string | undefined, host: ExportHost): Promise<void> {
  const name = sanitize(filename);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    if (!(await exists(SUBDIR, { baseDir: BaseDirectory.Download }))) {
      await mkdir(SUBDIR, { baseDir: BaseDirectory.Download, recursive: true });
    }
    await writeFile(`${SUBDIR}/${name}`, bytes, { baseDir: BaseDirectory.Download });
    host?.log?.('info', `Saved ${name} to Downloads/${SUBDIR}`);
    if (shareSheet(`${SUBDIR}/${name}`, blob.type, name)) {
      toast(`Saved “${name}” - choose where to send it`);
    } else {
      toast(`Saved “${name}” to Downloads/${SUBDIR}`);
    }
  } catch (err) {
    host?.log?.('error', 'Mobile export save failed', { error: String(err) });
    toast(`Couldn't save “${name}”: ${err instanceof Error ? err.message : String(err)}`, true);
    throw err;
  }
}

export function createExportAPI(host: ExportHost): WebExportAPI {
  const web = createWebExportAPI(host);
  return {
    ...web,
    async download(blob: Blob, filename: string) { await saveToDownloads(blob, filename, host); },
    async file(blob: Blob, opts: { filename?: string } = {}) { await saveToDownloads(blob, opts.filename || 'file', host); },
    // Native OS share. Android's ACTION_SEND needs the bytes persisted first, so this is
    // the same save-to-Downloads path - which already offers the native chooser via
    // shareSheet(). Returns true unconditionally: the file is delivered to the device
    // (and the sheet offered when the bridge is present) regardless of whether the chooser
    // actually opened, so the web caller never falls back and double-saves.
    async share(blob: Blob, opts: { filename?: string; mime?: string; title?: string } = {}): Promise<boolean> {
      await saveToDownloads(blob, opts.filename || 'file', host);
      return true;
    },
    // Native share is available only where the Android LollyShare bridge is present
    // (absent on iOS / older builds). The "Send to…" button gates on this, so it never
    // shows where a tap would only save to Downloads without offering the chooser.
    canShare(): boolean {
      return typeof window !== 'undefined' && typeof window.LollyShare?.shareFile === 'function';
    },
  };
}

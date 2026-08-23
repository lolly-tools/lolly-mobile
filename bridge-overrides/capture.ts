// SPDX-License-Identifier: MPL-2.0
/**
 * CaptureAPI (Tauri iOS) - page-to-image AND page-to-vector capture, the mobile
 * twin of shells/tauri-desktop/bridge-overrides/capture.ts (plans/138 / url-shot
 * on mobile). Replaces the web shell's throwing stub at build time via
 * vite.config.js's overrideBridgeModules resolveId override.
 *
 * Where desktop drives headless Chrome over CDP, iOS drives an OFFSCREEN
 * WKWebView natively (src-tauri/src/capture.rs, objc2-web-kit):
 *   page(spec)   → raster. `capture_page` snapshots the loaded WKWebView
 *                  (WKWebView.takeSnapshot) to a PNG and reports the page geometry.
 *   vector(spec) → true vector. `capture_page_pdf` prints the page to a vector PDF
 *                  (WKWebView.createPDF), which we convert to a standalone SVG
 *                  through the engine's PDF interpreter (the SAME pdf-import path a
 *                  .pdf/.ai upload takes) and WINDOW - scroll depth, crop insets
 *                  and the range extension become viewBox geometry, so a vector
 *                  shot frames identical content to a raster shot of one spec.
 *
 * The command names and result shapes are IDENTICAL to the desktop pair, so this
 * file is deliberately near-verbatim with it: only the shell behind the two
 * `invoke`s differs (WKWebView here, headless Chrome there). Android ships no such
 * command yet, so `capabilities-provided.ts` advertises 'capture' on iOS ONLY.
 *
 * Both results flow into the normal render/export path (units, format, provenance,
 * watermark) unchanged.
 */

import { invoke } from '@tauri-apps/api/core';
import { windowPdfSvg, HOOK_BUDGET_MS } from '@lolly/engine';
import type { AssetRef, CaptureAPI, CaptureSpec } from '@lolly-tools/core/host-v1';

/** Mirrors CaptureResult in src-tauri/src/capture.rs (serde camelCase). */
interface NativeCaptureResult {
  data: string;
  width: number;
  height: number;
  frameHeight: number;
  pageWidth: number;
  pageHeight: number;
  scrollY: number;
}

/** Mirrors VectorResult in src-tauri/src/capture.rs (serde camelCase). */
interface NativeVectorResult {
  data: string;
  pageWidth: number;
  pageHeight: number;
}

// url-shot captures in beforeExport, time-boxed at HOOK_BUDGET_MS.beforeExport
// (default 5s), and a real capture (a WKWebView navigation + the user's settle
// delay + snapshot/PDF) runs well past that. Raise it at bridge load (boot chunk,
// before any export), same as the desktop override. iOS only: the web stub throws
// instantly, so it never needs the longer wait.
HOOK_BUDGET_MS.beforeExport = Math.max(HOOK_BUDGET_MS.beforeExport, 90_000);

// 0..1 ⇒ fraction of the scrollable height, > 1 ⇒ px offset; clamped into range.
function resolveScroll(depth: number | undefined, pageH: number, viewportH: number): number {
  const max = Math.max(0, pageH - viewportH);
  if (depth == null) return 0;
  const px = depth <= 1 ? Math.max(0, depth) * max : depth;
  return Math.min(Math.max(0, px), max);
}

const clampInset = (v: number | undefined): number =>
  Number.isFinite(v) ? Math.min(0.9, Math.max(0, v as number)) : 0;

export function createCaptureAPI(): CaptureAPI {
  return {
    async page(spec: CaptureSpec): Promise<AssetRef> {
      const s = spec ?? ({} as CaptureSpec);
      if (!s.url) throw new Error('capture.page: a url is required');

      let res: NativeCaptureResult;
      try {
        res = await invoke<NativeCaptureResult>('capture_page', {
          spec: {
            url: s.url, width: s.width, height: s.height,
            scrollDepth: s.scrollDepth, rangeTo: s.rangeTo,
            waitMs: s.waitMs, dpr: s.dpr, css: s.css, crop: s.crop,
          },
        });
      } catch (e) {
        const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
        throw new Error(`Page capture failed: ${msg}`);
      }

      return {
        source: 'remote',
        id: `capture:${s.url}`,
        type: 'raster',
        format: 'png',
        url: `data:image/png;base64,${res.data}`,
        width: res.width,
        height: res.height,
        meta: {
          capturedFrom: s.url,
          frameHeight: res.frameHeight,
          scrollYPx: res.scrollY,
          pageWidth: res.pageWidth,
          pageHeight: res.pageHeight,
        },
      };
    },

    async vector(spec: CaptureSpec): Promise<AssetRef> {
      const s = spec ?? ({} as CaptureSpec);
      if (!s.url) throw new Error('capture.vector: a url is required');

      let res: NativeVectorResult;
      try {
        res = await invoke<NativeVectorResult>('capture_page_pdf', {
          spec: {
            url: s.url, width: s.width, height: s.height,
            scrollDepth: s.scrollDepth, rangeTo: s.rangeTo,
            waitMs: s.waitMs, dpr: s.dpr, css: s.css, crop: s.crop,
          },
        });
      } catch (e) {
        const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
        throw new Error(`Vector capture failed: ${msg}`);
      }

      const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
      const { openPdfFile } = await import('../../web/src/views/pdf-import.ts');
      const handle = await openPdfFile(blob);
      const page = await handle.pageToSvg(0);
      if (!page.elementCount) {
        throw new Error('Vector capture produced no drawable content - try a raster format.');
      }

      const vw = Math.max(1, s.width || res.pageWidth || page.width);
      const crop = s.crop || {};
      const cl = clampInset(crop.left), cr = clampInset(crop.right);
      const ct = clampInset(crop.top), cb = clampInset(crop.bottom);
      const hasCrop = cl || cr || ct || cb;
      const from = resolveScroll(s.scrollDepth, res.pageHeight, s.height ?? res.pageHeight);
      const extra = s.rangeTo != null
        ? Math.max(0, resolveScroll(s.rangeTo, res.pageHeight, s.height ?? res.pageHeight) - from)
        : 0;

      let svg = page.svg;
      let outW = res.pageWidth || page.width;
      let outH = res.pageHeight || page.height;
      const windowed = s.height != null || hasCrop || from > 0 || extra > 0;
      if (windowed) {
        const vh = s.height ?? res.pageHeight;
        const frameW = Math.max(1, vw * (1 - cl - cr));
        const frameH = Math.max(1, vh * (1 - ct - cb));
        const y = Math.min(from + vh * ct, Math.max(0, res.pageHeight - frameH));
        const h = Math.min(frameH + extra, Math.max(frameH, res.pageHeight - y));
        const ratio = page.width / vw; // points per CSS px
        svg = windowPdfSvg(page.svg, {
          x: vw * cl * ratio, y: y * ratio,
          width: frameW * ratio, height: h * ratio,
          outWidth: frameW, outHeight: h,
        });
        outW = frameW;
        outH = h;
      }

      return {
        source: 'remote',
        id: `capture-vector:${s.url}`,
        type: 'vector',
        format: 'svg',
        url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        width: Math.round(outW),
        height: Math.round(outH),
        meta: {
          capturedFrom: s.url,
          scrollYPx: from,
          pageWidth: res.pageWidth,
          pageHeight: res.pageHeight,
        },
      };
    },
  };
}

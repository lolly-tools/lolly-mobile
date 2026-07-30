// SPDX-License-Identifier: MPL-2.0
/**
 * Filesystem-backed state for the Tauri MOBILE shell — the platform seam only.
 *
 * Replaces the IndexedDB state bridge (shells/web/src/bridge/state.ts) at build
 * time via the resolveId override in vite.config.js. The API surface is identical
 * to the web shell and the desktop override — tools, the engine, the gallery, the
 * profile page and catalog sync never see which implementation is running, so every
 * method must be present or boot crashes.
 *
 * Storage: $APPDATA/Lolly/saved-state/<slot>.json
 *
 * The logic (slot-name codec, legacy-filename migration, record shape, asset-ref
 * collection) is shared with the desktop shell in ../../tauri-shared/bridge-overrides/state-fs.ts.
 * This file used to be a copy of the desktop one, kept separate so mobile-specific
 * behaviour could diverge later — but nothing had diverged, so every fix had to be
 * made twice with nothing enforcing it. The seam survives without the duplication:
 * mobile-specific storage (iCloud sync, Android scoped storage) goes in the `fs`
 * adapter below, or as an override on the object returned by createFsStateAPI, and
 * desktop stays untouched. This shell also owns the `@tauri-apps/plugin-fs`
 * dependency, which the parent repo cannot resolve (the Tauri shells are not npm
 * workspaces, so the plugin lives only in this shell's node_modules).
 */

import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
  readDir,
  remove,
} from '@tauri-apps/plugin-fs';
import { createFsStateAPI, type StateFs } from '../../tauri-shared/bridge-overrides/state-fs.ts';
import type { StateDb, WebStateAPI } from '../../web/src/bridge/state.ts';

// Paths are relative to $APPDATA/Lolly. readDirNames flattens tauri's entry
// objects to names, which is all the shared logic reads.
const appDataFs: StateFs = {
  exists: (path) => exists(path, { baseDir: BaseDirectory.AppData }),
  mkdirRecursive: (path) => mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true }),
  readTextFile: (path) => readTextFile(path, { baseDir: BaseDirectory.AppData }),
  writeTextFile: (path, text) => writeTextFile(path, text, { baseDir: BaseDirectory.AppData }),
  readDirNames: async (path) =>
    (await readDir(path, { baseDir: BaseDirectory.AppData })).map((entry) => entry.name),
  remove: (path) => remove(path, { baseDir: BaseDirectory.AppData }),
};

// createStateAPI signature matches the web shell (db param ignored — not needed here).
export function createStateAPI(_db: StateDb): WebStateAPI {
  return createFsStateAPI(appDataFs);
}

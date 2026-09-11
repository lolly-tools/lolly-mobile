#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * Refuse an Android build on a JDK Gradle cannot use.
 *
 * WHY THIS EXISTS: on a JDK newer than Gradle supports, `tauri android build`
 * fails deep inside Gradle with nothing but the version string as the message:
 *
 *     A problem occurred configuring project ':buildSrc'.
 *     > 25.0.4.1
 *
 * That is the entire diagnostic. It names no cause, no supported range, and no
 * remedy, and it arrives only AFTER cargo has built all four Android targets -
 * so on a cold tree you wait ~25 minutes to learn your JDK is wrong. Fedora 45
 * ships Java 25 as its only JDK, so this is the default experience there.
 *
 * `gradlew --version` is NOT a usable pre-check: it runs fine under an
 * unsupported JDK because it only exercises the launcher. Only project
 * configuration fails. So the check has to be its own thing, run up front.
 *
 * Bounds: Gradle 8.14.3 (gradle/wrapper/gradle-wrapper.properties) supports up
 * to Java 24; AGP 8.11 requires 17 or newer. Move MAX when the wrapper moves.
 *
 * This is a build-tool file, like vite.config.js, so it is .mjs: this shell's
 * tsconfig.json covers bridge-overrides/ only (DOM libs, webview code) and a .ts
 * here would sit outside every typecheck rather than inside one.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const MIN = 17; // AGP 8.11
const MAX = 24; // Gradle 8.14.3

const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';

// `java -version` writes to STDERR on every JDK worth supporting, so read both
// streams - an execFileSync return value is stdout only, and parsing that finds
// nothing, which made an earlier version of this guard pass every JDK silently.
const res = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
if (res.error) {
  console.error(`error: could not run "${javaBin} -version" - is a JDK installed?`);
  console.error(res.error.message);
  process.exit(1);
}
const raw = `${res.stderr ?? ''}${res.stdout ?? ''}`;

// "25.0.4.1" -> 25, "21.0.12.1" -> 21, legacy "1.8.0_292" -> 8.
const m = /version "(\d+)(?:\.(\d+))?/.exec(raw);
if (!m) {
  console.error(`warning: could not parse a version out of "${javaBin} -version":\n${raw.trim()}`);
  console.error('warning: proceeding anyway - this guard is advisory, not a gate on unknown output');
  process.exit(0);
}
const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);

if (major >= MIN && major <= MAX) {
  console.log(`JDK ${major} (${javaBin}) - within the supported ${MIN}-${MAX} range`);
  process.exit(0);
}

const tooNew = major > MAX;
console.error(`
error: JDK ${major} cannot build this project. Gradle 8.14.3 supports Java ${MIN}-${MAX}.
       found: ${javaBin}${process.env.JAVA_HOME ? ' (via JAVA_HOME)' : ' (via PATH)'}
       ${raw.trim().split('\n')[0]}
`);
if (tooNew) {
  console.error(`Without this check the build fails ~25 minutes from now, inside Gradle,
with "A problem occurred configuring project ':buildSrc'" followed by the bare
string "${major}.x" and nothing else.

Install a JDK in range and point JAVA_HOME at it for the build, e.g.:

    curl -fsSL -o jdk.tar.gz \\
      "https://api.adoptium.net/v3/binary/latest/${MAX}/ga/linux/x64/jdk/hotspot/normal/eclipse"
    mkdir -p ~/.local/jdk && tar -xzf jdk.tar.gz -C ~/.local/jdk
    JAVA_HOME=~/.local/jdk/jdk-<version> pnpm run build:android

Your system JDK is left alone; JAVA_HOME only affects this build.`);
} else {
  console.error(`AGP 8.11 requires Java ${MIN} or newer. Upgrade the JDK, or point JAVA_HOME at one.`);
}
process.exit(1);

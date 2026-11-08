import { resolve } from 'node:path';

export type Platform = 'ios' | 'android';

/** Where an app keeps its CLI on each platform. Paths are relative to the repo root. */
export interface PlatformTargets {
  /** A SwiftPM executable product, launched with `swift run --package-path <root>/<packagePath> <product>`. */
  ios: { packagePath: string; product: string; swiftArgs?: string[] };
  /** A gradle `installDist` launcher script, e.g. `android/cli/build/install/cli/bin/cli`. Run `:cli:installDist` first. */
  android: { executable: string };
}

/** Reads `FLOW_PLATFORM` (`ios` | `android`). */
export function currentPlatform(env: Record<string, string | undefined> = process.env): Platform {
  const value = env.FLOW_PLATFORM;
  if (value === 'ios' || value === 'android') return value;
  throw new Error(`FLOW_PLATFORM must be "ios" or "android" (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`);
}

/** The `command` to pass to `launch` for the chosen platform. */
export function platformCommand(root: string, targets: PlatformTargets, platform: Platform = currentPlatform()): string[] {
  if (platform === 'ios') {
    const { packagePath, product, swiftArgs = [] } = targets.ios;
    return ['swift', 'run', ...swiftArgs, '--package-path', resolve(root, packagePath), product];
  }
  return [resolve(root, targets.android.executable)];
}

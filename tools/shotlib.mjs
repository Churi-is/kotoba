/**
 * Shared setup for the browser tooling: resolve where Playwright's browsers actually
 * live, and explain the fix rather than throwing a stack trace if they are missing.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  // installed outside the project on purpose: ~230 MB of browser does not belong in a
  // repo, a backup, or a workspace quota (see tools/bootstrap.sh)
  '/opt/kotoba-tools/pw-browsers',
  join(homedir(), '.kotoba-tools/pw-browsers'),
  join(process.cwd(), 'tools/pw-browsers'),
  join(homedir(), '.cache/ms-playwright'),
  '/root/.cache/ms-playwright',
].filter(Boolean);

export function browserPath() {
  for (const c of CANDIDATES) {
    // a usable directory contains at least one chromium-* build
    try {
      if (existsSync(c) && existsSync(join(c, 'chromium_headless_shell-1243'))) return c;
    } catch {}
  }
  for (const c of CANDIDATES) if (c && existsSync(c)) return c;
  return null;
}

export function requireBrowsers() {
  const found = browserPath();
  if (!found) {
    console.error(
      '\nNo Playwright browsers found. Install them once:\n' +
      '  npx playwright install chromium\n' +
      'If they are somewhere unusual, set PLAYWRIGHT_BROWSERS_PATH.\n',
    );
    process.exit(3);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = found;
  return found;
}

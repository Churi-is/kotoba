/**
 * Screenshot harness — drives the real app in a real browser and writes PNGs.
 *
 *   npm run dev                 (in another terminal)
 *   npm run shots               → ./shots/*.png
 *   npm run shots -- --mobile   → only the phone-sized set
 *
 * Browsers are installed by `npx playwright install chromium`. If they live
 * outside the default cache, point PLAYWRIGHT_BROWSERS_PATH at the directory.
 *
 * It also records every console error and uncaught exception it sees, which makes
 * it a cheap runtime audit as well as a visual one.
 */
import { chromium } from 'playwright';
import { requireBrowsers } from './shotlib.mjs';

requireBrowsers();
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.OUT || 'shots';
const LEARNER = process.env.LEARNER || 'Lbeefcafe12345678abcd';
const MOBILE_ONLY = process.argv.includes('--mobile');
const ONLY = process.argv.filter((a) => !a.startsWith('-')).slice(2);
mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1440, height: 940 };
const MOBILE = { width: 390, height: 844 };

const problems = [];
const made = [];

console.log(`browsers: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function open(size = DESKTOP, label = 'ctx') {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 2,
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${label}: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${label}: ${String(e).slice(0, 200)}`));
  page.on('requestfailed', (r) => {
    // favicon noise and aborted navigations are not interesting
    const url = r.url();
    if (/favicon/.test(url)) return;
    problems.push(`[requestfailed] ${label}: ${r.method()} ${url} — ${r.failure()?.errorText}`);
  });
  await page.addInitScript((id) => localStorage.setItem('kotoba.learner', id), LEARNER);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 700);
  return { context, page };
}

const settle = async (page, ms = 450) => {
  try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
  await page.waitForTimeout(ms);
};

async function shot(page, name, opts = {}) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: opts.full ?? false });
  made.push(path);
  console.log(`  · ${name}`);
}

/** Click the first visible primary action inside a container, by text when given. */
async function advance(page, text, within = '#onbMain') {
  const scope = page.locator(within);
  const btn = text
    ? scope.getByRole('button', { name: text, exact: false }).first()
    : scope.locator('button.primary:visible').first();
  const fallback = scope.locator('button:visible', { hasText: /continue|next|finish|mark this|show me|wrap up|send|play forward/i }).first();
  const target = (await btn.count()) ? btn : fallback;
  if (!(await target.count())) return false;
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 3000 }).catch(() => {});
  await settle(page, 500);
  return true;
}

// ---------------------------------------------------------------- onboarding
async function walkPlacement(page, { mobile = false } = {}) {
  const suffix = mobile ? '-mobile' : '';
  await shot(page, `10-home${suffix}`);
  const placeBtn = page.locator('button:visible', { hasText: /start placement|re-run placement/i }).first();
  if (await placeBtn.count()) await placeBtn.click().catch(() => {});
  else await page.click('#startZero').catch(() => {});
  await page.waitForTimeout(1400);

  const stageIndex = () => page.evaluate(() => {
    const cur = document.querySelector('.onb-steps li.current');
    return cur ? [...cur.parentElement.children].indexOf(cur) : -1;
  });

  for (let i = 0; i < 14; i++) {
    const at = await stageIndex();
    if (at < 0) break;
    const label = await page.evaluate(() => (document.querySelector('.onb-steps li.current span:not(.num)')?.textContent || '').trim());
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 26);
    await page.waitForSelector('#onbMain .card', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, `${String(11 + i).padStart(2, '0')}-${slug}${suffix}`, { full: true });

    if (await page.locator('#onbMain .q .opt:visible').count()) {
      await page.locator('#onbMain .q .opt:visible').first().click().catch(() => {});
      await page.waitForTimeout(1200);
      await shot(page, `${11 + i}-${slug}-answered${suffix}`, { full: true });
      await page.waitForTimeout(1800);
      await shot(page, `${11 + i}-${slug}-next${suffix}`);
    } else if (await page.locator('#onbMain input[type=text]:visible').count()) {
      await page.locator('#onbMain input[type=text]:visible').first().fill('a').catch(() => {});
      await page.waitForTimeout(200);
    }

    for (let n = 0; n < 16; n++) {
      if (await stageIndex() !== at) break;
      const idk = page.locator('#onbMain button:visible', { hasText: /i don’t know this one/i }).first();
      if (!(await idk.count())) break;
      if (await idk.isDisabled().catch(() => false)) { await page.waitForTimeout(2700); continue; }
      if (/vocabulary|patterns/.test(slug) && n === 1) await shot(page, `${11 + i}-${slug}-unsure-pressed${suffix}`);
      await idk.click().catch(() => {});
      await page.waitForTimeout(2700);
    }

    for (let n = 0; n < 4; n++) {
      if (await stageIndex() !== at) break;
      const kana = page.locator('#onbMain button:visible', { hasText: /start the timer/i }).first();
      if (await kana.count()) {
        await kana.click().catch(() => {});
        await page.waitForTimeout(400);
        for (const inp of await page.locator('#onbMain input[type=text]:visible').all()) await inp.fill('a').catch(() => {});
        await shot(page, `${11 + i}-${slug}-timing${suffix}`);
        await page.locator('#onbMain button:visible', { hasText: /i’m done|check my/i }).first().click().catch(() => {});
        await page.waitForTimeout(800);
        continue;
      }
      const b = page.locator('#onbMain button:visible', { hasText: /continue|next|submit|ask me questions|see what i think|finish|start/i }).first();
      if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(900); continue; }
      const skip = page.locator('#onbMain button:visible', { hasText: /skip this/i }).first();
      if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(800); continue; }
      break;
    }
    if (await stageIndex() === at) break;
  }
  await page.waitForTimeout(2200);
  // the reveal only appears once the server has synthesised; wait for its own heading
  await page.getByText(/starting hypothesis|here.s what i think|what i think/i).first().waitFor({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, `25-reveal${suffix}`, { full: true });
}

// ---------------------------------------------------------------- a session
async function walkSession(page, { mobile = false, round = 0 } = {}) {
  const suffix = mobile ? '-mobile' : '';
  await page.click('[data-view="home"]').catch(() => {});
  await page.waitForTimeout(700);
  const startBtn = page.locator('#homeBody button:visible, #startPlacement:visible').filter({ hasText: /session/i }).first();
  if (!(await startBtn.count())) return false;
  await startBtn.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(1600);
  if (!(await page.locator('#view-session.active').count())) return false;

  await shot(page, `3${round}0-session-plan${suffix}`, { full: true });

  for (let beat = 0; beat < 8; beat++) {
    if (!(await page.locator('#view-session.active').count())) break;
    const title = await page.evaluate(() => {
      const h = document.querySelector('#stage .stage-head h2, #stage h2, #stage h1');
      return h ? h.textContent.trim() : '';
    });
    const slug = (title || `beat${beat}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
    await shot(page, `3${round}${beat + 1}-beat-${slug}${suffix}`, { full: true });

    if (await page.locator('#stage .opt:visible').count()) {
      await page.locator('#stage .opt:visible').first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, `3${round}${beat + 1}-beat-${slug}-answered${suffix}`, { full: true });
    } else if (await page.locator('#stage input[type=text]:visible, #stage textarea:visible').count()) {
      await page.locator('#stage input[type=text]:visible, #stage textarea:visible').first().fill('私は 大阪に 行きます。').catch(() => {});
      await page.waitForTimeout(400);
    }
    const next = page.locator('#stage button:visible').filter({ hasText: /^(mark & continue →|next →|mark & finish|finish session|Mark this activity|Wrap up this scene|Show me the debrief|Skip to the next activity →)$/ }).first();
    if (await next.count()) { await next.click().catch(() => {}); await page.waitForTimeout(1100); } else break;
  }
  // walk to the very end so the debrief is captured and not a mid-session beat
  for (let k = 0; k < 6; k++) {
    const fin = page.locator('button:visible').filter({ hasText: /^(finish session|mark & finish|End session here|Show me the debrief)$/ }).first();
    if (!(await fin.count())) break;
    await fin.click().catch(() => {});
    await page.waitForTimeout(1400);
    if (await page.locator('#stage').getByText(/next time|worth keeping|what you kept/i).count()) break;
  }
  await page.waitForTimeout(1200);
  await shot(page, `3${round}9-debrief${suffix}`, { full: true });
  return true;
}

// ---------------------------------------------------------------- other views
async function otherViews(page, { mobile = false } = {}) {
  const suffix = mobile ? '-mobile' : '';
  for (const [view, name] of [['progress', '40-progress'], ['memory', '41-memory'], ['home', '42-home-return']]) {
    await page.click(`[data-view="${view}"]`).catch(() => {});
    await page.waitForTimeout(1000);
    await shot(page, `${name}${suffix}`, { full: true });
  }
  await page.click('#healthBtn').catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, `43-status-modal${suffix}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, `44-after-escape${suffix}`);
}

// ---------------------------------------------------------------- run
try {
  if (!MOBILE_ONLY) {
    console.log('desktop walkthrough:');
    const { context, page } = await open(DESKTOP, 'desktop');
    await walkSession(page, { round: 0 });
    await walkSession(page, { round: 1 });
    await otherViews(page);
    await walkPlacement(page);
    await context.close();
  }

  console.log('mobile walkthrough:');
  const { context: mctx, page: mpage } = await open(MOBILE, 'mobile');
  await walkSession(mpage, { mobile: true, round: 0 });
  await walkPlacement(mpage, { mobile: true });
  await otherViews(mpage, { mobile: true });
  await mctx.close();
} catch (e) {
  problems.push(`[harness] ${String(e).slice(0, 300)}`);
} finally {
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ made, problems }, null, 2));
console.log(`\n${made.length} screenshots → ${OUT}/`);
if (problems.length) {
  console.log(`\n${problems.length} runtime problem(s):`);
  for (const p of [...new Set(problems)].slice(0, 40)) console.log('  ! ' + p);
} else {
  console.log('no console errors, page exceptions or failed requests.');
}

/**
 * Visual audit — loads every screen in a real browser and measures, instead of
 * eyeballing: text contrast (WCAG AA), tap-target sizes, elements overflowing their
 * container, and controls whose text is invisible against their own background.
 *
 *   node tools/audit.mjs                 → desktop + mobile, console report
 *   node tools/audit.mjs --out audit.json
 *
 * Exit code is 1 if anything at severity "fail" was found, so it can gate a commit.
 */
import { chromium } from 'playwright';
import { requireBrowsers } from './shotlib.mjs';

requireBrowsers();
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const LEARNER = process.env.LEARNER || 'Lbeefcafe12345678abcd';
const ARGS = process.argv.slice(2);
const OUT = ARGS.includes('--out') ? ARGS[ARGS.indexOf('--out') + 1] : null;

const findings = [];
const add = (severity, screen, detail) => findings.push({ severity, screen, ...detail });

/** Runs inside the page: walk the DOM, resolve effective colours, report contrast. */
const AUDIT_IN_PAGE = () => {
  const toRgb = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x));
    return { r, g, b, a };
  };
  const over = (fg, bg) => { // composite fg over bg, carrying alpha correctly
    const a = fg.a + bg.a * (1 - fg.a);
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / (a || 1),
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / (a || 1),
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / (a || 1),
      a,
    };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const gradStops = (cs) => {
    const img = cs.backgroundImage;
    if (!img || img === 'none') return [];
    const stops = [...img.matchAll(/rgba?\([^)]+\)/g)].map((m) => toRgb(m[0])).filter(Boolean);
    return stops.map((c) => (c.a < 1 ? c : c));
  };

  const bgOf = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const c = toRgb(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 1) return acc;
      node = node.parentElement;
    }
    return acc ? over(acc, { r: 13, g: 15, b: 19, a: 1 }) : { r: 13, g: 15, b: 19, a: 1 };
  };

  const out = { contrast: [], small: [], overflow: [], invisible: [], measured: 0 };
  const describe = (el) => {
    const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    const txt = (el.textContent || '').trim().slice(0, 42);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    out.measured += 1;

    // 1. contrast of *this element's own* text only (no descendants)
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) {
      const fg0 = toRgb(cs.color);
      if (fg0) {
        const parentBg = el.parentElement ? bgOf(el.parentElement) : { r: 13, g: 15, b: 19, a: 1 };
        const flat = cs.backgroundColor && toRgb(cs.backgroundColor).a >= 1 ? toRgb(cs.backgroundColor) : null;
        // worst case: text over the lightest gradient stop, or over its own flat bg
        const stops = gradStops(cs);
        const candidates = stops.length
          ? stops.map((c) => (c.a < 1 ? over(c, parentBg) : c))
          : [flat ?? bgOf(el)];
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 600;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        for (const bg of candidates) {
          const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
          const r = ratio(fg, bg);
          if (r < need) {
            out.contrast.push({ el: describe(el), ratio: Math.round(r * 100) / 100, need, size, color: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, text: own.slice(0, 46), gradient: stops.length > 0 });
            break;
          }
        }
      }
    }

    // 2. interactive elements that are too small to hit reliably
    const tag = el.tagName.toLowerCase();
    const interactive = tag === 'button' || tag === 'a' || tag === 'select' || tag === 'input' || el.getAttribute('role') === 'button';
    if (interactive && !el.closest('[hidden]')) {
      const w = rect.width, h = rect.height;
      if (h < 24 || w < 24) out.small.push({ el: describe(el), w: Math.round(w), h: Math.round(h) });
    }

    // 3. horizontal overflow past the viewport
    if (rect.right > window.innerWidth + 1 || rect.left < -1) {
      if (!el.closest('[style*="overflow"]')) {
        out.overflow.push({ el: describe(el), left: Math.round(rect.left), right: Math.round(rect.right), vw: window.innerWidth });
      }
    }
  }
  // 4. buttons whose computed text colour equals their own background (the classic
  // "invisible button" bug: a themed class never overrode the UA default)
  for (const b of document.querySelectorAll('button, .opt, .pill, .tab, .kana-cell')) {
    const cs = getComputedStyle(b);
    const fg = toRgb(cs.color), bg = toRgb(cs.backgroundColor);
    if (fg && bg && bg.a > 0.5) {
      const r = ratio(fg, bg.a < 1 ? over(bg, bgOf(b.parentElement ?? b)) : bg);
      if (r < 3) out.invisible.push({ el: describe(b), ratio: Math.round(r * 100) / 100, color: cs.color, bg: cs.backgroundColor });
    }
  }
  return out;
};

// --mobile runs the whole walkthrough at phone size, where most of this will be used
const MOBILE = ARGS.includes('--mobile');
console.log(`browsers: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 940 },
  deviceScaleFactor: 1,
  isMobile: MOBILE,
  hasTouch: MOBILE,
});
await context.addInitScript((id) => {
  localStorage.setItem('kotoba.learner', id);
}, LEARNER);
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

let elementsMeasured = 0;
const screensAudited = [];
const SHOT_DIR = process.env.SHOT_DIR || 'shots/audit';
const shot = async (p, name) => {
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(SHOT_DIR, { recursive: true });
    await p.screenshot({ path: `${SHOT_DIR}/${name.replace(/[^a-z0-9-]/gi, '_')}.png`, fullPage: true });
  } catch {}
};
async function audit(screen) {
  const r = await page.evaluate(AUDIT_IN_PAGE);
  screensAudited.push(screen);
  elementsMeasured += r.measured ?? 0;
  const bad = r.contrast.length + r.invisible.length + r.overflow.length + r.small.length;
  if (bad) await shot(page, screen);
  for (const c of r.contrast) add('fail', screen, { kind: 'contrast', ...c });
  for (const c of r.invisible) add('fail', screen, { kind: 'invisible-control', ...c });
  for (const c of r.overflow) add('warn', screen, { kind: 'overflow', ...c });
  for (const c of r.small) add('warn', screen, { kind: 'small-target', ...c });
  return r;
}

const S = (t) => Math.round(t);

// --- home / progress / memory
await audit('home');
for (const [view, name] of [['progress', 'progress'], ['memory', 'memory']]) {
  await page.click(`[data-view="${view}"]`);
  await page.waitForTimeout(900);
  await audit(name);
}
await page.click('[data-view="home"]');
await page.waitForTimeout(500);

// --- status modal
await page.click('#healthBtn');
await page.waitForTimeout(500);
await audit('status-modal');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// --- placement, one screen per stage, driven through every stage
const stageIndex = () => page.evaluate(() => {
  const cur = document.querySelector('.onb-steps li.current');
  return cur ? [...cur.parentElement.children].indexOf(cur) : -1;
});

const placeBtn = page.locator('button:visible', { hasText: /start placement|re-run placement/i }).first();
if (await placeBtn.count()) { await placeBtn.click().catch(() => {}); }
else { await page.click('#startZero').catch(() => {}); }
await page.waitForTimeout(1500);

for (let i = 0; i < 14; i++) {
  const at = await stageIndex();
  if (at < 0) break;
  const label = await page.evaluate(() => {
    const cur = document.querySelector('.onb-steps li.current span:not(.num)');
    return (cur?.textContent || '').trim();
  }).catch(() => '');
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);

  // wait for whatever this stage renders before touching it
  await page.waitForSelector('#onbMain .card', { timeout: 6000 }).catch(() => {});
  await page.waitForSelector('#onbMain .q, #onbMain button', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  await audit('placement:' + slug);

  // exercise the interactive parts while the screen is open
  if (await page.locator('#onbMain .q .opt:visible').count()) {
    await page.locator('#onbMain .q .opt:visible').first().click().catch(() => {});
    await page.waitForTimeout(1100);
    await audit('placement:' + slug + ':answered');
  } else if (await page.locator('#onbMain input[type=text]:visible').count()) {
    await page.locator('#onbMain input[type=text]:visible').first().fill('a').catch(() => {});
    await page.waitForTimeout(200);
    await audit('placement:' + slug + ':typed');
  }

  // Get out of the stage. Staircases are not skippable by design, so use the honest
  // "I don't know" path — which also exercises the unsure path end to end.
  for (let n = 0; n < 16; n++) {
    if (await stageIndex() !== at) break;
    const idk = page.locator('#onbMain button:visible', { hasText: /i don’t know this one/i }).first();
    if (!(await idk.count())) break;
    if (await idk.isDisabled().catch(() => false)) { await page.waitForTimeout(2700); continue; }
    await idk.click().catch(() => {});
    await page.waitForTimeout(2700);
  }

  for (let n = 0; n < 4; n++) {
    if (await stageIndex() !== at) break;
    // the kana stage is a deliberate two-step: start the clock, then submit
    const kana = page.locator('#onbMain button:visible', { hasText: /start the timer/i }).first();
    if (await kana.count()) {
      await kana.click().catch(() => {});
      await page.waitForTimeout(400);
      for (const inp of await page.locator('#onbMain input[type=text]:visible').all()) {
        await inp.fill('a').catch(() => {});
      }
      await page.locator('#onbMain button:visible', { hasText: /i’m done|check my/i }).first().click().catch(() => {});
      await page.waitForTimeout(700);
      continue;
    }
    const b = page.locator('#onbMain button:visible', { hasText: /continue|next|submit|ask me questions|see what i think|finish|start/i }).first();
    if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(800); continue; }
    const skip = page.locator('#onbMain button:visible', { hasText: /skip this/i }).first();
    if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(700); continue; }
    break;
  }
  if (await stageIndex() === at) break;
}

await page.waitForTimeout(1500);
await audit('placement:reveal');
await shot(page, 'placement-reveal');

// --- a session, every beat kind we can reach
await page.click('[data-view="home"]');
await page.waitForTimeout(700);
const start = page.locator('button:visible', { hasText: /session/i }).first();
if (await start.count()) {
  await start.click().catch(() => {});
  await page.waitForTimeout(1500);
  await audit('session:plan');
  for (let b = 0; b < 8; b++) {
    if (!(await page.locator('#view-session.active').count())) break;
    const t = await page.evaluate(() => {
      const el = document.querySelector('#stage h2, #stage h1, #stage .panel-title, #beats li.current');
      return el ? el.textContent.trim() : '';
    }).catch(() => '');
    const slug = (t || `beat${b}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 22);
    await audit('session:' + slug);
    // interact: click an option if the beat has one, then advance
    if (await page.locator('#stage .opt:visible').count()) {
      await page.locator('#stage .opt:visible').first().click().catch(() => {});
      await page.waitForTimeout(1400);
      await audit('session:' + slug + ':answered');
    } else if (await page.locator('#stage input[type=text]:visible, #stage textarea:visible').count()) {
      await page.locator('#stage input[type=text]:visible, #stage textarea:visible').first().fill('私は 大阪に 行きます。').catch(() => {});
      await page.waitForTimeout(200);
      await audit('session:' + slug + ':typed');
    }
    const next = page.locator('#stage button:visible', { hasText: /next activity|finish session|mark this|wrap up|show me the debrief|continue/i }).first();
    if (await next.count()) { await next.click().catch(() => {}); await page.waitForTimeout(900); } else break;
  }
  await page.waitForTimeout(1200);
  await audit('session:debrief');
}

// more sessions → more of the 16 tool kinds actually rendered and audited
for (let round = 0; round < 3; round++) {
  await page.click('[data-view="home"]').catch(() => {});
  await page.waitForTimeout(600);
  const s2 = page.locator('button:visible', { hasText: /session/i }).first();
  if (!(await s2.count())) break;
  await s2.click().catch(() => {});
  await page.waitForTimeout(1600);
  for (let b = 0; b < 8; b++) {
    if (!(await page.locator('#view-session.active').count())) break;
    const t = await page.evaluate(() => {
      const el = document.querySelector('#stage .stage-head h2, #stage h2, #stage h1, #stage .panel-title')
        ?? document.querySelector('#beats li.current');
      return el ? el.textContent.trim() : '';
    }).catch(() => '');
    await audit('session' + round + ':' + (t || 'beat').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20));
    if (await page.locator('#stage .opt:visible').count()) {
      await page.locator('#stage .opt:visible').first().click().catch(() => {});
      await page.waitForTimeout(1200);
    } else if (await page.locator('#stage input[type=text]:visible, #stage textarea:visible').count()) {
      await page.locator('#stage input[type=text]:visible, #stage textarea:visible').first().fill('私は 大阪に 行きます。').catch(() => {});
      await page.waitForTimeout(300);
    }
    const nx = page.locator('#stage button:visible').filter({ hasText: /^(mark & continue →|next →|mark & finish|finish session|Mark this activity|Wrap up this scene|Show me the debrief|Skip to the next activity →)$/ }).first();
    if (await nx.count()) { await nx.click().catch(() => {}); await page.waitForTimeout(900); } else break;
  }
  const fin = page.locator('button:visible', { hasText: /finish session|end session here/i }).first();
  if (await fin.count()) { await fin.click().catch(() => {}); await page.waitForTimeout(1200); }
}

await browser.close();

// ------------------------------------------------------------------ report
const seen = new Set();
const unique = findings.filter((f) => {
  const k = [f.severity, f.kind, f.screen, f.el?.replace(/"[^"]*"/, '')].join('|');
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const fails = unique.filter((f) => f.severity === 'fail');
const warns = unique.filter((f) => f.severity === 'warn');

const group = (list) => {
  const m = new Map();
  for (const f of list) {
    const key = `${f.kind} · ${f.el?.replace(/"[^"]*"/, '') ?? ''}`;
    if (!m.has(key)) m.set(key, { kind: f.kind, el: f.el, samples: [], screens: new Set(), worst: null });
    const g = m.get(key);
    if (g.samples.length < 3) g.samples.push({ screen: f.screen, ...f });
    g.screens.add(f.screen);
    if (typeof f.ratio === 'number' && (g.worst === null || f.ratio < g.worst)) g.worst = f.ratio;
  }
  return [...m.values()];
};

console.log(`\n${MOBILE ? 'mobile 390×844' : 'desktop 1440×940'}`);
console.log(`${screensAudited.length} screens audited, ${elementsMeasured} visible elements measured`);
console.log(`${unique.length ? `${fails.length} failing, ${warns.length} warning(s) across ${new Set(unique.map((f) => f.screen)).size} screens` : 'no contrast, sizing or overflow problems found'}\n`);
if (screensAudited.length < 5) {
  console.log('!! suspiciously few screens were audited — the walkthrough probably broke');
  process.exitCode = 2;
}
console.log('screens: ' + screensAudited.join(', ') + '\n');
if (fails.length) {
  console.log('FAIL — text or controls that do not meet AA:');
  for (const g of group(fails)) {
    console.log(`  ${g.kind}: ${g.el}`);
    for (const s of g.samples) {
      console.log(`      ${s.screen}  ratio ${s.ratio} (needs ${s.need ?? 3})  ${s.color} on ${s.bg}  ${s.text ? `"${s.text}"` : ''}`);
    }
    console.log(`      …on ${g.screens.size} screen(s)`);
  }
}
if (warns.length) {
  console.log('\nWARN:');
  for (const g of group(warns)) {
    console.log(`  ${g.kind}: ${g.el}  (${g.screens.size} screen(s))`);
    for (const s of g.samples) console.log(`      ${s.screen} ${s.w ?? ''}${s.h ? `×${s.h}` : ''}${s.left !== undefined ? ` left ${s.left} right ${s.right} vw ${s.vw}` : ''}`);
  }
}
if (OUT) { writeFileSync(OUT, JSON.stringify(unique, null, 2)); console.log(`\nfull report → ${OUT}`); }
console.log('');
process.exit(fails.length ? 1 : 0);

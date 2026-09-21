// app.js — shell, placement engine, and the two "insight" views.
//
// Views: Today (start a session), Progress (evidence over time), What I know (the model
// the AI reasons from — deliberately visible to the learner).

import { api, el, modal, toast, passageNode, relTime, saveClip, listClips, fmtMin, levelChip, tokenize, learnerId, storageAvailable } from './api.js';
import { speak, stop as stopAudio, Recorder, canRecord, contour, jaVoice, ttsAvailable } from './audio.js';
import { SessionRunner, renderDebrief } from './session.js';

const $ = (s) => document.querySelector(s);
export const state = { learner: null, profile: null, model: null, due: [], deck: null, health: null, placement: null };

const ICON = (k) => el('svg', { class: 'ic' }, el('use', { href: `#i-${k}` }));

// ---------------------------------------------------------------- boot

async function boot() {
  wireTabs();
  $('#startPlacement').onclick = () => beginPlacement(false);
  $('#startZero').onclick = () => beginPlacement(true);
  $('#healthBtn').onclick = showStatus;
  $('#endSession').onclick = () => endSession();
  $('#askTutor').onclick = askTutor;

  try { state.health = await api('/api/health'); } catch {}
  await refresh();
  route();
}

export async function refresh() {
  try {
    const data = await api('/api/learner');
    state.learner = data;
    state.profile = data.profile;
    state.model = data.model;
    state.due = data.due ?? [];
    state.deck = data.deck;
    $('#levelChip').textContent = state.model ? `${state.model.overall.cefr}${state.model.overall.jlptEstimate !== 'none' ? ' · ' + state.model.overall.jlptEstimate : ''}` : 'unplaced';
    $('#streakChip').textContent = `🔥 ${state.model?.streaks?.current ?? 0}`;
    banner();
    renderHome();
    if (state.model) { renderProgress(); renderMemory(); }
    else { $('#progressBody').replaceChildren(emptyState('Finish placement first — then this fills with real evidence.')); $('#memoryBody').replaceChildren(emptyState('Nothing to remember yet.')); }
  } catch (e) {
    $('#app').prepend(el('div', { class: 'banner bad' }, 'Could not reach the tutor service: ' + e.message));
  }
}

function banner() {
  const b = $('#banner');
  const h = state.health;
  if (!h) return;
  if (!h.modelKey) {
    b.className = 'banner bad';
    b.replaceChildren(
      ICON('info'),
      // Two texts, one shown per viewport: on a phone the long version pushed the
      // actual lesson six lines down the screen.
      el('span', { class: 'grow banner-long', text: 'The tutor cannot run: no Gemini key is configured on the server, and there is no scripted fallback. Placement, sessions, marking and review all need the model. Add GEMINI_API_KEY (or an AI Gateway) and redeploy.' }),
      el('span', { class: 'grow banner-short', text: 'Tutor not configured — the app needs a Gemini key to run.' }),
      el('button', { class: 'ghost small', onclick: showStatus }, 'how to fix'),
    );
  } else {
    b.className = 'banner hidden';
  }
}

function emptyState(text) { return el('div', { class: 'card muted' }, text); }

function wireTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t.dataset.view));
      if (t.dataset.view === 'progress') renderProgress();
      if (t.dataset.view === 'memory') renderMemory();
    };
  });
}

function show(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
}

function route() {
  if (!state.model) show('home');
  else show('home');
}

function showStatus() {
  const h = state.health ?? {};
  modal(el('div', {},
    el('h2', { text: 'Environment' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'app' }), el('dd', { text: h.app ?? 'Kotoba' }),
      el('dt', { text: 'AI mode' }), el('dd', { text: h.aiMode ?? '—' }),
      el('dt', { text: 'model key' }), el('dd', {}, h.modelKey ? el('span', { class: 'tag ok', text: 'configured' }) : el('span', { class: 'tag warn', text: 'missing — tutor disabled' })),
      el('dt', { text: 'AI gateway' }), el('dd', { text: h.gateway ? 'routed through Cloudflare AI Gateway' : 'direct to Google' }),
      el('dt', { text: 'planner' }), el('dd', { class: 'mono', text: h.models?.planner ?? '—' }),
      el('dt', { text: 'in-session tutor' }), el('dd', { class: 'mono', text: h.models?.tutor ?? '—' }),
      el('dt', { text: 'voice' }), el('dd', { class: 'mono', text: h.models?.live ?? '—' }),
      el('dt', { text: 'TTS' }), el('dd', { class: 'mono', text: h.models?.tts ?? '—' }),
      el('dt', { text: 'tools' }), el('dd', { text: `${h.tools ?? 0} activity types available to the planner` }),
      el('dt', { text: 'browser voice' }), el('dd', { text: ttsAvailable() ? (jaVoice() ? 'ja-JP speech synthesis available' : 'speech synthesis present, no ja voice found') : 'none' }),
      el('dt', { text: 'your learner id' }), el('dd', { class: 'mono', text: learnerId() }),
      el('dt', { text: 'local storage' }), el('dd', { text: storageAvailable() ? 'available (id survives a reload)' : 'blocked — this session uses an in-memory id' }),
      el('dt', { text: 'mic' }), el('dd', { text: canRecord() ? 'available' : 'unavailable' }),
    ),
    h.modelKey ? null : el('div', { class: 'hint', style: { marginTop: '14px' } },
      el('strong', { text: 'The tutor is off until a key is set — nothing runs without it. To enable: ' }),
      el('div', { class: 'mono small', style: { marginTop: '6px', whiteSpace: 'pre-wrap' }, text: 'wrangler secret put GEMINI_API_KEY\n# then redeploy and reload — no other changes needed\n# or route via AI Gateway:\nwrangler secret put CF_AIG_TOKEN\n# plus vars CF_AI_GATEWAY_ACCOUNT and CF_AI_GATEWAY_ID' }),
    ),
    el('div', { class: 'row gap', style: { marginTop: '16px' } },
      el('button', { class: 'primary', onclick: () => modal('') }, 'close'),
      el('button', { class: 'ghost', onclick: () => { modal(''); resetLearner(); } }, 'reset my learner data'),
    ),
  ));
}

async function resetLearner() {
  // Clearing the cookie is enough — the DO is keyed by the signed learner id.
  document.cookie = 'kt=; Path=/; Max-Age=0';
  toast('Learner reset. Reloading…');
  setTimeout(() => location.reload(), 700);
}

// ---------------------------------------------------------------- home

async function renderHome() {
  const body = $('#homeBody');
  if (!state.model) {
    $('#heroTitle').textContent = 'はじめまして';
    const n = state.placement?.stages?.length ?? 12;
    const optional = state.placement?.stages?.filter((s) => s.skippable).length ?? 5;
    $('#heroSub').textContent = `${n} short stages, about half an hour: a timed kana check, two adaptive staircases, reading speed, listening, speaking, writing, then a four-minute conversation. The staircases run to the end because they are the measurement — every item has an honest “I don’t know” — and the other ${optional} stages can be skipped, which is recorded as lower confidence rather than a failure.`;
    if (state.learner?.placementState === 'active') $('#placementProgress').textContent = 'in progress';
    body.replaceChildren(
      el('div', { class: 'grid three' },
        feature('Escape the beginner plateau', 'The staircase starts at A2.1 and walks up until you miss, so nothing gets re-taught that you already know.'),
        feature('Measured, not self-reported', 'Reading words-per-minute, kana reaction time, and your own production are all measured. Self-ratings are recorded separately and compared.'),
        feature('An honest confidence level', 'Every estimate ships with how sure the tutor is and what evidence it rests on. Low evidence means it will re-test, not guess.'),
      ),
      el('div', { class: 'card', style: { marginTop: '18px' } },
        el('h3', { text: 'How the sessions work' }),
        el('p', { class: 'muted small', text: 'The AI designs every session against your model — which error patterns you keep repeating, what is about to fall out of memory, and the situations you said you need. The app provides the tools it composes: conversation, quizzes, shadowing, graded reading, listening labs, kanji labs, free production, register drills.' }),
        el('div', { class: 'row gap wrap' }, ...['16 activity types', 'spaced repetition from real production', 'tutor notebook that persists', 'voice or text', '5 to 45 minute sessions'].map((t) => el('span', { class: 'tag', text: t }))),
      ),
    );
    return;
  }

  $('#heroTitle').textContent = state.profile?.name ? `おかえりなさい、${state.profile.name}` : 'おかえりなさい';
  $('#heroSub').textContent = state.profile?.goals?.detail || 'Welcome back.';
  $('#placementProgress').textContent = 'complete';
  $('#placementBar').style.width = '100%';
  const sp = $('#startPlacement');
  sp.textContent = 'Start today’s session';
  sp.onclick = () => startSession({});
  const sz = $('#startZero');
  sz.textContent = 'Re-run placement';
  sz.onclick = () => beginPlacement(false);

  const preview = await api('/api/preview/tomorrow').catch(() => null);
  body.replaceChildren(
    el('div', { class: 'grid two' },
      el('div', { class: 'card' },
        el('div', { class: 'panel-title' }, 'today'),
        el('h3', { text: `${state.model.overall.cefr} · ${state.due.length} card${state.due.length === 1 ? '' : 's'} due` }),
        preview ? el('div', {},
          el('p', { class: 'small muted', text: `Plan shape: ${preview.shape.map((s) => `${s.kind} ${s.minutes}m`).join(' → ')}` }),
          el('p', { class: 'small muted', text: preview.why }),
          preview.focusErrors?.length ? el('div', { class: 'row gap wrap' },
            el('span', { class: 'small muted', text: 'targeting:' }),
            ...preview.focusErrors.map((e) => el('span', { class: 'tag warn', text: `${e.label} ×${e.count}` }))) : null,
        ) : null,
        el('div', { class: 'row gap wrap', style: { marginTop: '14px' } },
          ...['5', '10', '20', '30'].map((m) => el('button', {
            class: 'pill' + (Number(m) === state.profile?.constraints?.sessionLength ? ' on' : ''),
            onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); },
            dataset: { minutes: m },
          }, m + ' min')),
        ),
        el('div', { class: 'row gap wrap', style: { marginTop: '10px' } },
          el('button', { class: 'primary', onclick: () => startSession({}) }, 'Start session'),
          el('button', { class: 'ghost', onclick: () => startSession({ mode: 'voice' }) }, 'Voice session'),
          el('button', { class: 'ghost', onclick: () => startSession({ goalHint: 'input' }) }, 'I\'m tired — give me input'),
          el('button', { class: 'ghost', onclick: () => startSession({ goalHint: 'speaking' }) }, 'Push my speaking'),
        ),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'panel-title' }, 'quick tools'),
        el('div', { class: 'row gap wrap' },
          el('button', { class: 'soft', onclick: showReview }, `review ${state.due.length} due cards`),
          el('button', { class: 'ghost', onclick: showStory }, 'story mode'),
          el('button', { class: 'ghost', onclick: showClips }, 'hear past you'),
          el('button', { class: 'ghost', onclick: askTutor }, 'ask about my learning'),
        ),
        state.model.notes?.length ? el('div', { style: { marginTop: '14px' } },
          el('div', { class: 'panel-title' }, 'from the tutor’s notebook'),
          ...state.model.notes.slice(-3).map((n) => el('div', { class: 'small muted', style: { marginBottom: '6px' }, text: '· ' + n })),
        ) : null,
      ),
    ),
  );
}

function feature(t, d) {
  return el('div', { class: 'card' }, el('h3', { text: t }), el('p', { class: 'small muted', text: d }));
}

// ---------------------------------------------------------------- session

async function startSession({ minutes, mode, goalHint }) {
  const chosen = minutes ?? Number(document.querySelector('.pill.on')?.dataset?.minutes ?? state.profile?.constraints?.sessionLength ?? 20);
  const body = {
    minutes: chosen,
    mode: mode ?? (state.profile?.constraints?.modePreference === 'voice' ? 'voice' : 'text'),
    goalHint,
  };
  show('session');
  const status = el('span', { text: ' Aoi is designing today’s session from your model…' });
  $('#stage').replaceChildren(el('div', { class: 'card' }, el('span', { class: 'spin' }), status));
  $('#beats').replaceChildren();
  // Session design is the slowest call in the app — a reasoning model writing a whole
  // lesson plan. Narrate the wait so 30–60s reads as progress, not a hang.
  const t0 = Date.now();
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    if (s > 45) status.textContent = ' Still designing — the planner is thinking hard. This can take up to about 90 seconds…';
    else if (s > 15) status.textContent = ' Still designing — weighing your errors, due cards and goals…';
  }, 2000);
  try {
    const { plan, meta, recipe } = await api('/api/session/start', { body });
    clearInterval(tick);
    window.__session = new SessionRunner({
      plan, meta, recipe,
      onExit: async (again) => { await refresh(); again ? startSession({}) : show('home'); },
    });
    window.__session.render($('#stage').parentElement.querySelector('#stage'));
    $('#notebook').textContent = 'Corrections and observations will appear here as we go.';
  } catch (e) {
    clearInterval(tick);
    // A failed plan is retryable, not a dead end: nothing is stored server-side until a
    // plan validates, so trying again is always safe. Timeouts especially clear on retry.
    $('#stage').replaceChildren(el('div', { class: 'card' },
      el('h3', { text: 'Could not start a session' }),
      el('p', { class: 'muted', text: e.message }),
      el('div', { class: 'row gap', style: { marginTop: '8px' } },
        el('button', { class: 'primary small', onclick: () => startSession({ minutes: chosen, mode: body.mode, goalHint }) }, 'Try again'),
        e.data?.error === 'ai_not_configured' ? el('button', { class: 'ghost small', onclick: showStatus }, 'how to fix') : null,
      )));
  }
}

async function endSession() {
  if (!window.__session) { show('home'); return; }
  await window.__session.finish();
}

async function showReview() {
  show('session');
  $('#beats').replaceChildren();
  const wrap = el('div');
  $('#stage').replaceChildren(wrap);
  const { due, stats } = await api('/api/review/due');
  if (!due.length) { wrap.replaceChildren(el('div', { class: 'card' }, el('h3', { text: 'Nothing due right now' }), el('p', { class: 'muted small', text: 'Come back tomorrow — or start a session and I will weave new items in.' }))); return; }
  let i = 0;
  const card = el('div');
  wrap.replaceChildren(el('div', { class: 'panel-title', text: `review · ${due.length} due · ${stats.total} in deck (${stats.mature} mature)` }), card);
  const draw = () => {
    const c = due[i];
    if (!c) { wrap.replaceChildren(el('div', { class: 'card' }, el('h3', { text: 'Deck clear. お疲れさま！' }))); return; }
    const reveal = el('div', { class: 'hint', style: { display: 'none' } },
      el('div', { class: 'jp', style: { fontSize: '20px' }, text: c.reading || c.surface }),
      el('div', { text: c.meaning ?? '' }),
      c.tags?.length ? el('div', { class: 'row gap', style: { marginTop: '6px' } }, ...c.tags.map((t) => el('span', { class: 'tag', text: t }))) : null,
    );
    const grades = ['again', 'hard', 'good', 'easy'];
    const gradeRow = el('div', { class: 'row gap', style: { marginTop: '14px' } },
      ...grades.map((g, gi) => el('button', {
        class: gi === 0 ? 'danger' : gi === 3 ? 'soft' : 'ghost',
        onclick: async () => {
          await api('/api/review/grade', { body: { id: c.id, grade: gi + 1 } });
          i++; draw();
        },
      }, g)),
    );
    card.replaceChildren(el('div', { class: 'q' },
      el('div', { class: 'small muted', text: `${i + 1} / ${due.length} · ${c.kind} · stability ${c.stability.toFixed(1)}d` }),
      el('div', { class: 'prompt jp', text: c.surface }),
      el('button', { class: 'ghost small', style: { marginTop: '10px' }, onclick: (e) => { reveal.style.display = 'block'; e.target.remove(); } }, 'show answer'),
      reveal,
      gradeRow,
    ));
  };
  draw();
}

async function showStory() {
  show('session');
  const wrap = el('div', { class: 'card' }, el('span', { class: 'spin' }), ' writing today’s episode…');
  $('#stage').replaceChildren(wrap);
  $('#beats').replaceChildren();
  try {
    const { story } = await api('/api/tools/story', { body: {} });
    const p = el('div', { class: 'passage', style: { margin: '12px 0' } });
    p.append(passageNode(story.text, { newWords: (story.glossary ?? []).map((g) => g.surface), onTap: async (term, ev) => {
      const g = await api('/api/tools/gloss', { body: { term, context: story.text } });
      const box = el('div', { class: 'gloss' }, el('div', { class: 'w jp', text: term }), el('div', { class: 'r jp', text: g.reading || '' }), el('div', { text: g.meaningEN || '' }));
      box.style.left = Math.min(window.innerWidth - 340, ev.clientX) + 'px';
      box.style.top = (ev.clientY + 14) + 'px';
      document.body.append(box);
      setTimeout(() => document.addEventListener('click', () => box.remove(), { once: true }), 50);
    } }));
    wrap.replaceChildren(
      el('h2', { class: 'jp', text: story.titleJA }), el('div', { class: 'small muted', text: story.titleEN }),
      el('div', { class: 'row gap', style: { marginTop: '10px' } }),
      p,
      el('div', { class: 'row gap wrap' }, ...(story.glossary ?? []).map((g) => el('span', { class: 'tag shu jp', text: `${g.surface}（${g.reading}）` }))),
      story.hook ? el('div', { class: 'hint', style: { marginTop: '10px' }, text: story.hook }) : null,
      el('button', { class: 'primary small', style: { marginTop: '14px' }, onclick: () => showStory() }, 'next episode'),
    );
  } catch { wrap.replaceChildren(el('p', { class: 'muted', text: 'Story mode failed — try again.' })); }
}

async function showClips() {
  const clips = await listClips(12);
  modal(el('div', {},
    el('h2', { text: 'Hear past you' }),
    el('p', { class: 'muted small', text: 'Recordings you make in conversation and shadowing are stored in this browser only — never uploaded. Comparing week 1 with week 6 is one of the most convincing kinds of progress evidence there is.' }),
    clips.length ? el('div', {}, ...clips.map((c) => el('div', { class: 'row between', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
      el('div', {}, el('div', { text: c.label }), el('div', { class: 'tiny muted', text: relTime(c.ts) })),
      el('button', { class: 'ghost small', onclick: () => { const a = new Audio(URL.createObjectURL(c.blob)); a.play(); } }, '▶'),
    ))) : el('p', { class: 'muted', text: 'No recordings yet. Use the mic button in a conversation activity.' }),
    el('button', { class: 'primary', style: { marginTop: '14px' }, onclick: () => modal('') }, 'close'),
  ));
}

// ---------------------------------------------------------------- tutor Q&A

function askTutor() {
  const q = el('textarea', { rows: 2, placeholder: 'e.g. why do I keep getting particles wrong?', style: { minHeight: '70px' } });
  const out = el('div');
  modal(el('div', {},
    el('h2', { text: 'Ask Aoi about your learning' }),
    el('p', { class: 'muted small', text: 'Aoi answers from your model — your error history, deck, session log and goals — not from general advice.' }),
    q,
    el('div', { class: 'row gap', style: { marginTop: '10px' } },
      el('button', { class: 'primary', onclick: async (e) => {
        e.target.disabled = true;
        out.replaceChildren(el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' thinking…'));
        try {
          const r = await api('/api/tutor/ask', { body: { question: q.value } });
          out.replaceChildren(el('div', { class: 'card', style: { marginTop: '14px' } }, el('div', { class: 'small muted', text: 'Aoi' }), el('p', { text: r.answer })));
        } catch (err) { out.replaceChildren(el('div', { class: 'card' }, 'Could not answer: ' + err.message)); }
        e.target.disabled = false;
      } }, 'ask'),
      el('button', { class: 'ghost', onclick: () => modal('') }, 'close'),
    ),
    out,
  ));
}

// ================================================================ placement

async function beginPlacement(zero) {
  const started = await api('/api/placement/start', { body: { zero } });
  state.placement = { stages: started.stages, i: 0, responses: {}, zero };
  show('onboarding');
  renderStage();
}

function renderStage() {
  const p = state.placement;
  const stage = p.stages[p.i];
  const rail = $('#onbRail');
  $('#placementBar').style.width = `${Math.round((p.i / p.stages.length) * 100)}%`;
  $('#placementProgress').textContent = `stage ${p.i + 1} of ${p.stages.length}`;

  rail.replaceChildren(el('ol', { class: 'onb-steps' }, ...p.stages.map((s, i) => el('li', {
    class: i === p.i ? 'current' : i < p.i ? 'done' : '',
  }, el('span', { class: 'num', text: i < p.i ? '✓' : String(i + 1) }), el('span', {}, s.title)))));

  const main = $('#onbMain');
  main.replaceChildren(
    el('div', { class: 'stage-head' },
      el('h2', { class: 'jp', text: stage.titleJA }),
      el('h1', { style: { fontSize: '26px' }, text: stage.title }),
      el('p', { class: 'muted', text: stage.blurb }),
    ),
    el('div', { class: 'because' }, ICON('info'), el('span', { text: stage.because })),
  );

  const host = el('div');
  main.append(host);
  const render = STAGE_RENDERERS[stage.id];
  if (typeof render === 'function') render(stage, host);
  else host.append(el('div', { class: 'card muted' }, 'This stage has no UI yet.'));

  main.append(el('div', { class: 'stage-actions' },
    p.i > 0 ? el('button', { class: 'ghost', onclick: () => { p.i--; renderStage(); } }, '← back') : null,
    stage.skippable ? el('button', { class: 'ghost', onclick: () => skip(stage) }, 'skip this') : null,
    el('span', { class: 'small muted', text: `~${stage.minutes} min` }),
  ));
}

function next(data) {
  const p = state.placement;
  p.responses[p.stages[p.i].id] = data;
  api('/api/placement/stage', { body: { stage: p.stages[p.i].id, payload: data } }).catch(() => {});
  updateEvidence();
  p.i++;
  if (p.i >= p.stages.length) return finishPlacement();
  renderStage();
  $('#onbMain').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function skip(stage) {
  toast(`Skipped ${stage.title} — recorded as lower confidence in ${(stage.id === 'reading' ? 'reading' : stage.id)}.`);
  api('/api/placement/stage', { body: { stage: stage.id, payload: { skipped: true } } }).catch(() => {});
  next({ skipped: true });
}

function updateEvidence() {
  const r = state.placement.responses;
  const lines = [];
  if (r.goal) lines.push(`Goal: ${r.goal.primary}${r.goal.detail ? ` — ${r.goal.detail}` : ''}`);
  if (r.background) lines.push(`Background: ${r.background.yearsStudying ?? 0} years, ${r.background.inJapanMonths ?? 0} months in Japan`);
  if (r.script?.kana) {
    const acc = r.script.kana.filter((k) => k.correct).length / r.script.kana.length;
    lines.push(`Kana: ${Math.round(acc * 100)}% accurate, median ${median(r.script.kana.map((k) => k.ms))}ms`);
  }
  if (r.vocabulary?.estimate) lines.push(`Vocabulary band: ${r.vocabulary.estimate.cefr} (${Math.round(r.vocabulary.estimate.accuracy * 100)}% on the staircase)`);
  if (r.grammar?.estimate) lines.push(`Grammar band: ${r.grammar.estimate.cefr}`);
  if (r.reading && !r.reading.skipped) {
    const wpm = Number(r.reading.wpm);
    const tot = Number(r.reading.total);
    const ok = Number(r.reading.correct);
    const bits = [];
    if (Number.isFinite(wpm) && wpm > 0) bits.push(`${Math.round(wpm)} wpm`);
    if (Number.isFinite(tot) && tot > 0) bits.push(`${Math.round(((ok || 0) / tot) * 100)}% comprehension`);
    // Speed and comprehension are the two halves of the measurement; say which half
    // is missing rather than printing undefined.
    if (bits.length) lines.push(`Reading: ${bits.join(' at ')}`);
    else lines.push('Reading: passage read, but the timing did not come through');
  }
  if (r.listening && !r.listening.skipped) {
    const nat = Number(r.listening.natural);
    const slow = Number(r.listening.slowed);
    if (Number.isFinite(nat) && Number.isFinite(slow)) {
      lines.push(`Listening: ${Math.round(nat * 100)}% at natural speed, ${Math.round(slow * 100)}% slowed — a ${Math.round((slow - nat) * 100)} point gap`);
    } else if (r.listening.correct !== undefined) {
      lines.push(`Listening: ${r.listening.correct}/${r.listening.total ?? '?'}`);
    }
  }
  if (r.speaking && !r.speaking.skipped) {
    const n = r.speaking.turns?.length ?? r.speaking.probes?.length ?? 0;
    lines.push(n ? `Speaking: ${n} probe${n === 1 ? '' : 's'} captured` : 'Speaking: stage finished with nothing recorded');
  }
  if (r.writing && !r.writing.skipped) {
    const n = r.writing.samples?.length ?? 0;
    lines.push(n ? `Writing: ${n} sample${n === 1 ? '' : 's'}` : 'Writing: stage finished with nothing recorded');
  }
  if (r.interview && !r.interview.skipped) {
    const n = r.interview.turns?.length ?? 0;
    lines.push(`Interview: ${n} turn${n === 1 ? '' : 's'}`);
  }
  if (r.style) lines.push('Style: recorded — this shapes what I set next');
  $('#evidenceLive').replaceChildren(
    lines.length ? el('div', {}, ...lines.map((l) => el('div', { style: { marginBottom: '5px' }, text: '· ' + l }))) : document.createTextNode('Nothing yet. Answer a stage and this fills in.'),
  );
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const STAGE_RENDERERS = {};

STAGE_RENDERERS.goal = (stage, host) => {
  const p = state.profile ?? {};
  const fields = {};
  const sel = (key, options, value, label) => {
    const s = el('select', { onchange: (e) => fields[key] = e.target.value });
    options.forEach(([v, t]) => s.append(el('option', { value: v, selected: value === v }, t)));
    return el('label', { class: 'fld' }, el('span', { text: label }), s);
  };
  host.append(el('div', { class: 'card' },
    el('label', { class: 'fld' }, el('span', { text: 'What are you actually trying to do with Japanese?' }),
      el('div', { class: 'pills' }, ...[
        ['travel', 'Travel'], ['jlpt', 'Pass JLPT'], ['work_visa', 'Work in Japan'], ['media', 'Anime / manga / games'],
        ['family_partner', 'Partner / family'], ['study_abroad', 'Study abroad'], ['heritage', 'Heritage'], ['fun', 'Just enjoy it'],
      ].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); fields.primary = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'In your own words — where will you use it?' }),
      el('input', { type: 'text', placeholder: 'e.g. I move to Osaka in March for work; I need to survive meetings and make friends', oninput: (e) => fields.detail = e.target.value })),
    el('label', { class: 'fld' }, el('span', { text: 'Specific situations you need to handle' }),
      el('input', { type: 'text', placeholder: 'doctor visits, work emails, izakaya with colleagues', oninput: (e) => fields.realSituations = e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })),
    el('div', { class: 'grid three' },
      sel('targetLevel', [['A1', 'A1 — basics'], ['A2', 'A2 — everyday'], ['B1', 'B1 — independent'], ['B2', 'B2 — professional'], ['C1', 'C1 — near-native']], 'A2', 'Target level'),
      sel('targetJLPT', [['none', 'not aiming at JLPT'], ['N5', 'JLPT N5'], ['N4', 'N4'], ['N3', 'N3'], ['N2', 'N2'], ['N1', 'N1']], 'none', 'JLPT target'),
      el('label', { class: 'fld' }, el('span', { text: 'Deadline (if any)' }), el('input', { type: 'date', onchange: (e) => fields.deadlineISO = e.target.value })),
    ),
    el('div', { class: 'grid four' },
      sel('sessionLength', [['5', '5 min'], ['10', '10 min'], ['20', '20 min'], ['30', '30 min'], ['45', '45 min']], '20', 'Typical session'),
      sel('daysPerWeek', [['2', 'twice a week'], ['3', '3×'], ['4', '4×'], ['5', '5×'], ['7', 'daily']], '4', 'How often'),
      sel('modePreference', [['text', 'typing'], ['voice', 'speaking out loud'], ['either', 'mix of both']], 'either', 'Preferred mode'),
      el('label', { class: 'fld' }, el('span', { text: 'Mic available?' }),
        el('select', { onchange: (e) => fields.hasMic = e.target.value === 'yes' }, el('option', { value: 'yes' }, 'yes'), el('option', { value: 'no' }, 'no — I type'))),
    ),
    el('button', {
      class: 'primary',
      onclick: () => next({
        primary: fields.primary ?? 'fun', detail: fields.detail ?? '', realSituations: fields.realSituations ?? [],
        targetLevel: fields.targetLevel ?? 'A2', targetJLPT: fields.targetJLPT ?? 'none', deadlineISO: fields.deadlineISO,
        sessionLength: Number(fields.sessionLength ?? 20), daysPerWeek: Number(fields.daysPerWeek ?? 4),
        modePreference: fields.modePreference ?? 'either', hasMic: fields.hasMic !== false,
        minutesPerDay: Number(fields.sessionLength ?? 20),
        device: window.innerWidth < 700 ? 'phone' : 'desktop',
        quietEnvironments: false,
      }),
    }, 'Continue →'),
  ));
};

STAGE_RENDERERS.background = (stage, host) => {
  const f = {};
  host.append(el('div', { class: 'card' },
    el('label', { class: 'fld' }, el('span', { text: 'Roughly how long have you been studying Japanese?' }),
      el('input', { type: 'number', min: '0', step: '0.5', placeholder: 'years (0 is fine)', oninput: (e) => f.years = Number(e.target.value) })),
    el('label', { class: 'fld' }, el('span', { text: 'Months lived in Japan' }),
      el('input', { type: 'number', min: '0', placeholder: '0', oninput: (e) => f.months = Number(e.target.value) })),
    el('label', { class: 'fld' }, el('span', { text: 'Have you taken any formal classes or courses?' }),
      el('select', { onchange: (e) => f.classes = e.target.value === 'yes' }, el('option', { value: 'no' }, 'no, self-taught'), el('option', { value: 'yes' }, 'yes'))),
    el('label', { class: 'fld' }, el('span', { text: 'Any tests already? (JLPT / JFT-Basic)' }),
      el('div', { class: 'row gap wrap' },
        el('select', { onchange: (e) => f.testLevel = e.target.value },
          el('option', { value: '' }, 'none'), el('option', { value: 'N5' }, 'JLPT N5'), el('option', { value: 'N4' }, 'JLPT N4'), el('option', { value: 'N3' }, 'JLPT N3'), el('option', { value: 'N2' }, 'JLPT N2'), el('option', { value: 'N1' }, 'JLPT N1'), el('option', { value: 'A2' }, 'JFT-Basic A2'), el('option', { value: 'A2.1' }, 'JFT-Basic A2.1'), el('option', { value: 'A1' }, 'JFT-Basic A1')),
        el('input', { type: 'number', placeholder: 'score (optional)', oninput: (e) => f.testScore = Number(e.target.value) }),
        el('input', { type: 'number', placeholder: 'year', oninput: (e) => f.testYear = Number(e.target.value) }),
      )),
    el('p', { class: 'small muted', text: 'Recorded, but never trusted over measurement — a passed N4 from four years ago and an N4 you would pass today are different learners.' }),
    el('button', {
      class: 'primary',
      onclick: () => next({
        yearsStudying: f.years ?? 0, inJapanMonths: f.months ?? 0, formalClasses: Boolean(f.classes),
        priorTests: f.testLevel ? [{ test: f.testLevel.startsWith('N') ? 'JLPT' : 'JFT', level: f.testLevel, score: f.testScore, year: f.testYear }] : [],
        selfRating: {},
      }),
    }, 'Continue →'),
  ));
};

STAGE_RENDERERS.script = (stage, host) => {
  const kana = stage.probes.kana ?? [];
  const results = [];
  const grid = el('div', { class: 'kanagrid' });
  kana.forEach((k, idx) => {
    const cell = el('div', { class: 'kana-cell' },
      el('div', { class: 'k kana', text: k.kana }),
      el('input', { type: 'text', placeholder: 'romaji', autocomplete: 'off' }),
    );
    grid.append(cell);
  });
  let startedAt = 0;
  let ticker = 0;
  const status = el('span', { class: 'small muted', text: 'Start the timer, then type each romaji as fast as you can.' });
  const check = el('button', { class: 'primary', onclick: () => {
    if (!startedAt) {
      startedAt = Date.now();
      check.textContent = 'I’m done — check my answers';
      status.textContent = 'Timing… go! Type romaji for each kana below.';
      status.classList.add('timing');
      ticker = setInterval(() => {
        const left = inputs.filter((i) => !i.value.trim()).length;
        status.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${left} left`;
      }, 100);
      [...grid.querySelectorAll('input')].forEach((inp, i) => { inputs[i].t0 = Date.now(); inp.focus?.(); });
      return;
    }
    clearInterval(ticker);
    [...grid.children].forEach((cell, i) => {
      const given = cell.querySelector('input').value.trim().toLowerCase();
      const ms = Date.now() - (inputs[i].t0 ?? startedAt);
      const correct = given === kana[i].romaji || (kana[i].romaji === 'o' && given === 'wo');
      cell.classList.add(correct ? 'ok' : 'bad');
      results.push({ kana: kana[i].kana, given, correct, ms });
    });
    const acc = Math.round((results.filter((r) => r.correct).length / results.length) * 100);
    status.textContent = `${acc}% accurate, median ${median(results.map((r) => r.ms))}ms. Sending to the model…`;
    check.disabled = true;
    next({ kana: results });
  } }, 'Start the timer');
  const inputs = [...grid.querySelectorAll('input')];
  inputs.forEach((inp, i) => {
    inp.setAttribute('aria-label', `Romaji for kana ${(kana[i] ?? {}).kana ?? i + 1}`);
    inp.addEventListener('focus', () => { if (!inp.t0) inp.t0 = Date.now(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inputs[i + 1]?.focus(); } });
  });

  host.append(el('div', { class: 'card' },
    el('p', { class: 'small muted', text: 'Knowledge is not the same as automaticity. If you know these but take 2 seconds each, you cannot yet read comfortably — I need to know that.' }),
    grid,
    el('div', { class: 'row gap', style: { marginTop: '14px' } }, check, status),
  ));
};

function adaptiveStage(section, title) {
  return (stage, host) => {
    const card = el('div', { class: 'card' });
    const progress = el('span', { class: 'small muted', text: 'item 1' });
    const itemHost = el('div');
    host.append(card, el('div', { style: { marginTop: '12px' } }, progress));
    card.append(
      el('p', { class: 'small muted', text: `${title} — items get harder until you miss, then settle back. Accuracy is corrected for guessing (on a four-option item you would score 25% by chance, and that is subtracted out), so if you are not sure, say so rather than guessing.` }),
      itemHost,
    );
    let answers = 0;
    const draw = async (item) => {
      let pr = engine.progress;
      let it = item;
      if (!it) {
        const res = await api('/api/placement/item', { body: { section } });
        it = res.item;
        pr = res.progress;
        engine.progress = pr;
      }
      if (!it) { host.append(el('p', { class: 'muted', text: 'That is the end of this staircase.' })); return; }
      const limit = pr?.limit ?? 14;
      progress.textContent = `item ${Math.min((pr?.served ?? answers) + 1, limit)} of ${limit} · current band ${pr?.level ?? engine.level ?? '—'}`;
      const e = engine.estimate;
      if (e?.n >= 3) {
        // Below three answered items a corrected percentage is noise dressed as
        // precision — one lucky answer reads as "100%".
        progress.textContent += ` · ${Math.round(e.adjusted * 100)}% once chance is removed`;
      } else if (e?.n) {
        progress.textContent += ` · ${e.n} answered`;
      }
      if (e?.unsure) progress.textContent += ` · ${e.unsure} unsure`;
      const opts = el('div', { class: 'opts' });
      const prompt = el('div', { class: 'prompt jp', text: it.prompt });
      const explain = el('div', { class: 'explain' });
      const cardEl = el('div', { class: 'q' }, prompt, opts, explain);
      itemHost.replaceChildren(cardEl);
      let answered = false;

      const answer = async (given, unsure) => {
        if (answered) return;
        answered = true;
        const r = await api('/api/placement/answer', { body: { section, id: it.id, given, unsure } });
        if (!unsure) {
          [...opts.children].forEach((b) => {
            if (b.textContent === r.target) b.classList.add('correct');
            else if (b.textContent === given) b.classList.add('wrong');
          });
        }
        explain.classList.toggle('unsure', Boolean(unsure));
        explain.textContent = unsure
          ? `Noted as unsure — it does not count against you the way a wrong answer does. 答え: ${r.target} — ${r.explanation}`
          : (r.correct ? '✓ ' : `✗ ${r.target} — `) + r.explanation;
        idk.disabled = true;
        answers++;
        engine.estimate = r.estimate;
        engine.level = r.progress?.level ?? engine.level;
        engine.limit = r.progress?.limit ?? engine.limit;
        engine.progress = { ...(engine.progress ?? {}), ...(r.progress ?? {}) };
        setTimeout(() => {
          if (r.next) draw(r.next);
          else { next({ estimate: engine.estimate, section, unsure: r.estimate?.unsure ?? 0 }); }
        }, unsure ? 2600 : r.correct ? 700 : 2000);
      };

      (it.options ?? []).forEach((o) => opts.append(el('button', { class: 'opt', onclick: () => answer(o, false) }, o)));

      // The escape hatch. Forced guessing on a placement test is how you end up
      // placing a cautious learner below their real level, and how you teach people
      // to answer hopefully instead of honestly.
      const idk = el('button', { class: 'idk', onclick: () => answer(null, true) },
        'I don’t know this one');
      const hintNote = el('span', { class: 'tiny muted', text: 'Say so honestly — it is better evidence than a lucky guess.' });
      const row = el('div', { class: 'opt-row' }, idk, hintNote);

      if (it.hint) {
        row.insertBefore(el('button', {
          class: 'idk',
          onclick: (e) => {
            // Showing the reading does not reveal the meaning, so it is a fair nudge —
            // but it is still evidence that the kanji was the obstacle, so we record it.
            e.target.disabled = true;
            hintNote.textContent = `Reading: ${it.hint}`;
            hintNote.classList.remove('muted');
            // recorded as a placement event so the synthesis can weight it
            api('/api/placement/hint', { body: { section, id: it.id } }).catch(() => {});
          },
        }, 'give me the reading'), idk);
        hintNote.textContent = 'The reading is a fair nudge; not knowing is useful information.';
      }
      cardEl.append(row);
    };
    const engine = { estimate: null, progress: null, level: null, limit: 14 };
    draw(null);
  };
}
STAGE_RENDERERS.vocabulary = adaptiveStage('vocabulary', 'Vocabulary staircase');
STAGE_RENDERERS.grammar = adaptiveStage('grammar', 'Pattern staircase');

STAGE_RENDERERS.reading = (stage, host) => {
  const p = (stage.probes.passages ?? [])[0];
  if (!p) return next({});
  let startedAt = Date.now();
  host.append(el('div', { class: 'card' },
    el('p', { class: 'small muted', text: 'Read it once, at your normal speed. The timer stops when you press the button — take as long as the text needs, not as long as you can prevaricate.' }),
    el('div', { class: 'passage', style: { marginTop: '10px' } }, p.text),
    el('button', { class: 'primary', style: { marginTop: '14px' }, onclick: (e) => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      showQuestions(p.questions, seconds);
      e.target.remove();
    } }, 'I’ve read it — ask me questions'),
  ));

  function showQuestions(questions, seconds) {
    let correct = 0;
    const box = el('div', { class: 'card', style: { marginTop: '14px' } });
    host.append(box);
    questions.forEach((q, i) => {
      const opts = el('div', { class: 'opts' });
      const wrap = el('div', { class: 'q' }, el('div', { class: 'prompt jp', text: q.prompt }), opts);
      let answered = false;
      q.options.forEach((o) => opts.append(el('button', { class: 'opt', onclick: (e) => {
        if (answered) return;
        answered = true;
        const ok = o === q.answer;
        if (ok) correct++;
        e.target.classList.add(ok ? 'correct' : 'wrong');
        wrap.append(el('div', { class: 'explain jp', text: (ok ? '✓ ' : `✗ ${q.answer} — `) + q.explanation }));
        if (questions.every((_, j) => box.querySelectorAll('.q')[j]?.querySelector('.explain'))) {
          const chars = [...p.text].length;
          next({ chars, seconds, correct, total: questions.length, wpm: Math.round(chars / Math.max(0.2, seconds / 60)) });
        }
      } }, o)));
      box.append(wrap);
    });
  }
};

STAGE_RENDERERS.listening = (stage, host) => {
  const clips = stage.probes.clips ?? [];
  let correct = 0, total = 0, idx = 0;
  const box = el('div', { class: 'card' });
  host.append(box);
  const draw = () => {
    const clip = clips[idx];
    if (!clip) return next({ correct, total, clips: clips.length });
    const opts = el('div', { class: 'opts' });
    const wrap = el('div', { class: 'q' },
      el('div', { class: 'row between' }, el('strong', { text: clip.title }), el('span', { class: 'small muted', text: `${idx + 1} / ${clips.length}` })),
      el('div', { class: 'row gap wrap', style: { margin: '10px 0' } },
        el('button', { class: 'primary small', onclick: () => speak(clip.script, {}) }, '▶ play'),
        el('button', { class: 'ghost small', onclick: () => speak(clip.script, { rate: 0.85 }) }, '▶ slower'),
      ),
      ...clip.questions.map((q) => {
        const qw = el('div', { style: { marginTop: '12px' } }, el('div', { class: 'prompt jp', text: q.prompt }), opts);
        q.options.forEach((o) => opts.append(el('button', { class: 'opt', onclick: (e) => {
          total++;
          const ok = o === q.answer;
          if (ok) correct++;
          e.target.classList.add(ok ? 'correct' : 'wrong');
          qw.append(el('div', { class: 'explain jp', text: (ok ? '✓ ' : `✗ ${q.answer} — `) + q.explanation }));
        } }, o)));
        return qw;
      }),
      el('button', { class: 'primary small', style: { marginTop: '14px' }, onclick: () => { idx++; draw(); } }, 'next clip →'),
    );
    box.replaceChildren(wrap);
  };
  draw();
};

STAGE_RENDERERS.speaking = (stage, host) => {
  const probes = stage.probes.probes ?? [];
  const turns = [];
  const card = el('div', { class: 'card' });
  host.append(card);
  card.append(
    el('p', { class: 'small muted', text: 'Speak your answers. If you have no mic, type what you would say — I will mark the language and note the missing audio as a gap in confidence.' }),
  );
  probes.forEach((probe, i) => {
    const area = el('textarea', { class: 'jp', rows: 2, placeholder: '話したことを 書いてください（または マイクで録音）' });
    const status = el('span', { class: 'small muted' });
    const row = el('div', { class: 'q' },
      el('div', { class: 'row between' }, el('strong', { class: 'small', text: `${i + 1}. ${probe.level}` }), status),
      el('div', { class: 'prompt jp', text: probe.prompt }),
      el('div', { class: 'small muted', text: probe.promptEN }),
      area,
      el('div', { class: 'row gap wrap', style: { marginTop: '10px' } },
        canRecord() ? el('button', { class: 'soft small', onclick: async (e) => {
          const rec = new Recorder();
          e.target.textContent = '● stop';
          if (!rec.media) { await rec.start(); return; }
          const done = await rec.stop();
          await saveClip({ id: `probe-${probe.id}-${Date.now()}`, ts: Date.now(), label: `Placement: ${probe.promptEN.slice(0, 40)}`, blob: done.blob });
          const bars = await contour(done.blob);
          status.textContent = `recorded ${Math.round(done.ms / 1000)}s`;
          row.append(el('div', { class: 'pitchviz' }, ...bars.map((v) => el('i', { style: { height: v + '%' } }))),
            el('button', { class: 'ghost small', onclick: () => { const a = new Audio(done.url); a.play(); } }, '▶ hear yourself'));
          e.target.remove();
        } }, '● record') : null,
        el('button', { class: 'ghost small', onclick: () => { speak(probe.prompt); } }, '▶ hear the prompt'),
        el('button', { class: 'soft small', onclick: () => {
          turns.push({ role: 'learner', text: area.value.trim(), probe: probe.id, level: probe.level });
          status.textContent = 'saved';
          area.disabled = true;
        } }, 'save answer'),
      ),
    );
    card.append(row);
  });
  card.append(el('button', { class: 'primary', style: { marginTop: '14px' }, onclick: () => next({ turns }) }, 'Continue →'));
};

STAGE_RENDERERS.writing = (stage, host) => {
  const probes = stage.probes.probes ?? [];
  const samples = [];
  const card = el('div', { class: 'card' });
  host.append(card);
  probes.forEach((probe, i) => {
    const area = el('textarea', { class: 'jp', rows: 4, placeholder: '日本語で書いてください…' });
    const count = el('span', { class: 'small muted', text: `min ${probe.minChars} chars` });
    area.oninput = () => { count.textContent = `${area.value.length} / ${probe.minChars}`; };
    card.append(el('div', { class: 'q' },
      el('div', { class: 'prompt jp', text: probe.prompt }),
      el('div', { class: 'small muted', text: probe.promptEN }),
      area,
      el('div', { class: 'row between' }, count,
        el('button', { class: 'soft small', onclick: (e) => {
          samples.push({ id: probe.id, level: probe.level, text: area.value });
          area.disabled = true;
          e.target.textContent = 'saved ✓';
        } }, 'save')),
    ));
  });
  card.append(el('button', { class: 'primary', style: { marginTop: '14px' }, onclick: () => {
    const jpChars = samples.reduce((a, s) => a + (s.text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length, 0);
    const totalChars = samples.reduce((a, s) => a + s.text.length, 0) || 1;
    next({ samples, score: Math.min(1, (jpChars / totalChars) * 0.6 + Math.min(1, totalChars / 200) * 0.4) });
  } }, 'Continue →'));
};

STAGE_RENDERERS.interview = (stage, host) => {
  const card = el('div', { class: 'card' });
  const log = el('div', { class: 'chat' });
  const turns = [];
  const prompts = [
    { ja: 'お名前と、日本語を 勉強している 理由を 教えてください。', en: 'Tell me your name and why you are studying Japanese.' },
    { ja: '日本語で いちばん 難しいと 思うのは 何ですか。', en: 'What do you find hardest about Japanese?' },
    { ja: '今週、何を しましたか。', en: 'What did you do this week?' },
  ];
  let i = 0;
  host.append(card);
  card.append(
    el('p', { class: 'small muted', text: 'The part no quiz can measure: can you steer a conversation, repair it when it breaks, and keep someone interested? Answer in Japanese if you can — mixing in English is allowed and it gets recorded as such.' }),
    log,
  );
  const area = el('textarea', { class: 'jp', rows: 2, placeholder: '日本語で 答えてみてください…' });
  const draw = () => {
    const q = prompts[i];
    if (!q) {
      const jpRatio = turns.reduce((a, t) => a + (t.text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length / Math.max(1, t.text.length), 0) / Math.max(1, turns.length);
      const len = turns.reduce((a, t) => a + t.text.length, 0) / Math.max(1, turns.length);
      card.append(el('div', { class: 'hint', text: 'That is enough for me to judge interaction, not vocabulary. Thanks.' }),
        el('button', { class: 'primary', style: { marginTop: '12px' }, onclick: () => next({ turns, score: Math.min(1, jpRatio * 0.7 + Math.min(1, len / 60) * 0.3) }) }, 'Continue →'));
      return;
    }
    const bubble = el('div', { class: 'msg tutor' }, el('span', { class: 'avatar', text: '葵' }), el('div', { class: 'bubble jp' },
      el('div', {}, q.ja), el('div', { class: 'en', text: q.en })));
    log.append(bubble);
    const send = el('button', { class: 'primary small', onclick: () => {
      const text = area.value.trim() || '(nothing)';
      turns.push({ role: 'learner', text });
      log.append(el('div', { class: 'msg learner' }, el('span', { class: 'avatar', text: 'you' }), el('div', { class: 'bubble jp', text })));
      area.value = '';
      i++;
      draw();
    } }, 'answer');
    card.append(area, el('div', { class: 'row gap', style: { marginTop: '8px' } }, send,
      el('button', { class: 'ghost small', onclick: () => { area.value = 'すみません、もう一度 ゆっくり お願いします。'; } }, 'I didn’t catch that')));
  };
  draw();
};

STAGE_RENDERERS.style = (stage, host) => {
  const f = { interests: [], painPoints: [], avoidTopics: [] };
  const toggleList = (key, options) => el('div', { class: 'pills' }, ...options.map((o) => el('button', {
    class: 'pill', onclick: (e) => {
      const on = e.target.classList.toggle('on');
      f[key] = on ? [...(f[key] ?? []), o] : (f[key] ?? []).filter((x) => x !== o);
    },
  }, o)));
  host.append(el('div', { class: 'card' },
    el('label', { class: 'fld' }, el('span', { text: 'When I correct you, when should it happen?' }),
      el('div', { class: 'pills' }, ...[['during', 'as I go'], ['pause', 'pause me if it keeps happening'], ['after', 'at the end, not during']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.correctionTiming = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'How should corrections land?' }),
      el('div', { class: 'pills' }, ...[['gentle', 'gentle — lead me to it'], ['socratic', 'ask me questions until I get it'], ['direct', 'just tell me, bluntly']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.correctionStyle = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'How much English should I use?' }),
      el('div', { class: 'pills' }, ...[['none', 'Japanese only'], ['hints', 'Japanese, English hints'], ['explanations', 'explain grammar in English'], ['lots', 'lots of English for now']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.l1Support = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'Romaji?' }),
      el('div', { class: 'pills' }, ...[['always', 'always show it'], ['on_demand', 'only if I tap'], ['never', 'never — force me to read kana']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.romaji = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'Kanji appetite' }),
      el('div', { class: 'pills' }, ...[['avoid', 'keep it manageable'], ['steady', 'steady drip'], ['aggressive', 'throw them at me']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.kanjiAppetite = v; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'Do you care about pitch accent?' }),
      el('div', { class: 'pills' }, ...[['yes', 'yes, I want to sound right'], ['no', 'not really, just be understood']].map(([v, t]) => el('button', {
        class: 'pill', onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); f.pitchAccentInterest = v === 'yes'; },
      }, t)))),
    el('label', { class: 'fld' }, el('span', { text: 'What should we talk about? (pick a few)' }), toggleList('interests', ['food & cooking', 'anime & manga', 'music', 'gaming', 'sports', 'travel', 'technology', 'business', 'history', 'film', 'art', 'nature', 'cars', 'parenting'])),
    el('label', { class: 'fld' }, el('span', { text: 'Anything you never want to talk about?' }), toggleList('avoidTopics', ['politics', 'religion', 'personal finances', 'family', 'health'])),
    el('label', { class: 'fld' }, el('span', { text: 'What has frustrated you most about learning Japanese so far?' }),
      el('input', { type: 'text', placeholder: 'e.g. I can read but freeze when I speak', oninput: (e) => f.painPoints = e.target.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean) })),
    el('label', { class: 'fld' }, el('span', { text: 'Why are you actually doing this? (your words)' }),
      el('input', { type: 'text', placeholder: 'the honest version', oninput: (e) => f.motivationNote = e.target.value })),
    el('button', { class: 'primary', onclick: () => next({
      correctionTiming: f.correctionTiming ?? 'after', correctionStyle: f.correctionStyle ?? 'gentle',
      l1Support: f.l1Support ?? 'explanations', romaji: f.romaji ?? 'on_demand',
      kanjiAppetite: f.kanjiAppetite ?? 'steady', pitchAccentInterest: Boolean(f.pitchAccentInterest),
      interests: f.interests, avoidTopics: f.avoidTopics, painPoints: f.painPoints, motivationNote: f.motivationNote ?? '',
    }) }, 'Continue →'),
  ));
};

STAGE_RENDERERS.reveal = (stage, host) => {
  host.append(el('div', { class: 'card' }, el('span', { class: 'spin' }), ' Synthesising everything into a starting hypothesis…'));
  finishPlacement(true);
};

async function finishPlacement(renderOnly) {
  if (state.placement.done && !renderOnly) return;
  state.placement.done = true;
  const p = state.placement;
  const rail = $('#onbRail');
  rail.replaceChildren(el('div', { class: 'panel' }, el('div', { class: 'panel-title', text: 'placement complete' }),
    el('p', { class: 'small muted', text: 'Evidence collected. Now I tell you what I think — and how sure I am.' })));
  try {
    const r = await api('/api/placement/finish', { body: {} });
    state.model = r.model;
    await refresh();
    renderReveal(r);
  } catch (e) {
    // The evidence is stored server-side, so a failed synthesis is retryable as-is —
    // the learner answered 12 stages; they should not retake them because one model
    // call hiccuped.
    const retry = () => {
      $('#onbMain').replaceChildren(el('div', { class: 'card' }, el('span', { class: 'spin' }), ' Synthesising everything into a starting hypothesis…'));
      finishPlacement(true);
    };
    const notConfigured = e.data?.error === 'ai_not_configured';
    $('#onbMain').replaceChildren(el('div', { class: 'card' }, el('h3', { text: 'Could not finish placement' }), el('p', { class: 'muted', text: e.message }),
      notConfigured ? el('button', { class: 'ghost small', style: { marginTop: '8px' }, onclick: showStatus }, 'how to fix') : null,
      notConfigured ? null : el('button', { class: 'ghost small', style: { marginTop: '8px' }, onclick: retry }, 'try again')));
  }
}

function renderReveal(r) {
  const m = r.model;
  const host = $('#onbMain');
  const skills = Object.entries(m.skills);
  host.replaceChildren(
    el('div', { class: 'stage-head' },
      el('h2', { class: 'jp', text: '結果' }),
      el('h1', { style: { fontSize: '28px' }, text: `I'd start you at ${m.overall.cefr}` }),
      el('p', { class: 'muted', text: `Overall confidence ${Math.round(m.overall.confidence * 100)}%. This is my starting hypothesis, not a verdict.` }),
    ),
    el('div', { class: 'because' }, ICON('info'), el('span', { text: 'The next four sessions will re-calibrate this. Treat anything with low confidence as a question I am still asking.' })),

    el('div', { class: 'card' },
      el('div', { class: 'panel-title', text: 'per-skill estimate' }),
      ...skills.map(([k, v]) => el('div', { class: 'radar-row' },
        el('span', { text: k }),
        el('div', { class: 'bar ai' }, el('i', { style: { width: (indexOf(v.cefr) + v.percentile / 100) / 10 * 100 + '%' } })),
        el('span', { class: 'jp', text: v.cefr }),
      )),
      el('div', { class: 'small muted', style: { marginTop: '10px' } },
        `Vocabulary ≈ ${m.vocabSizeEstimate.toLocaleString()} words · kanji ≈ ${m.kanjiKnown} · reading ${m.metrics.readingWPM} wpm · listening at native speed ${Math.round(m.metrics.listeningAccuracyAtNativeSpeed * 100)}%`),
    ),

    el('div', { class: 'grid two' },
      el('div', { class: 'card' }, el('div', { class: 'panel-title', text: 'what you already have' }),
        ...(r.strengths?.length ? r.strengths.map((s) => el('div', { class: 'win', text: s })) : [el('div', { class: 'win', text: 'You completed a genuinely long placement — that is data most apps never collect.' })])),
      el('div', { class: 'card' }, el('div', { class: 'panel-title', text: 'where the work is' }),
        ...(r.focusAreas?.length ? r.focusAreas.map((s) => el('div', { class: 'small', style: { marginBottom: '8px' }, text: '· ' + s })) : [el('div', { class: 'small muted', text: 'No focus areas identified yet.' })])),
    ),

    el('div', { class: 'card' },
      el('div', { class: 'panel-title', text: 'your first four weeks' }),
      ...(r.firstMonthPlan ?? []).map((w, i) => el('div', { class: 'row gap', style: { marginBottom: '8px' } },
        el('span', { class: 'tag ai', text: `week ${i + 1}` }), el('span', { class: 'small', text: w }))),
      el('div', { class: 'small muted', style: { marginTop: '8px' } },
        `Recommended session shape: ${r.recommendedRecipe} · target Japanese ratio ${Math.round((r.readingSupport?.targetRatio ?? 0.7) * 100)}% · at most ${r.readingSupport?.maxNewTokensPerPassage} new items per reading`),
    ),

    el('div', { class: 'card' },
      el('div', { class: 'panel-title', text: 'how sure I am — and why' }),
      ...(r.caveats?.length ? r.caveats.map((c) => el('div', { class: 'hint', style: { marginBottom: '8px' }, text: c })) : [el('p', { class: 'small muted', text: 'Reasonable confidence across the board.' })]),
      el('div', { class: 'small muted', style: { marginTop: '10px' }, text: 'Correct me if I am wrong — you know things about your Japanese that I cannot see:' }),
      el('div', { class: 'row gap wrap', style: { marginTop: '8px' } },
        ...[['speaking', 'too low'], ['reading', 'too low'], ['listening', 'too low'], ['grammar', 'too low']].map(([skill, label]) => el('button', {
          class: 'ghost small',
          onclick: async () => {
            const cur = m.skills[skill].cefr;
            const up = indexOf(cur) >= 8 ? cur : order[Math.min(order.length - 1, indexOf(cur) + 1)];
            await api('/api/learner/correct-level', { body: { skill, cefr: up, note: 'learner said placement was too low' } });
            toast(`Noted — I'll test that assumption in the next two sessions rather than take it on faith.`);
          },
        }, `${label} (raise ${skill})`)),
      ),
    ),

    el('div', { class: 'row gap', style: { marginTop: '18px' } },
      el('button', { class: 'primary', onclick: () => { refresh(); show('home'); setTimeout(() => startSession({}), 300); } }, 'Start session 1 →'),
      el('button', { class: 'ghost', onclick: () => show('home') }, 'Look around first'),
    ),
  );
}

const order = ['pre-A1', 'A1', 'A1+', 'A2.1', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'C1'];
const indexOf = (l) => Math.max(0, order.indexOf(l));

// ================================================================ progress + memory

async function renderProgress() {
  const host = $('#progressBody');
  if (!state.model) return;
  const p = await api('/api/progress').catch(() => null);
  if (!p) return;
  const m = p.model ?? state.model;
  const sessions = p.sessions ?? [];
  host.replaceChildren(
    el('div', { class: 'grid three' },
      stat('Sessions', String(m.streaks.totalSessions), `${m.streaks.current} day streak · best ${m.streaks.longest}`),
      stat('Time on task', fmtMin(m.streaks.totalMinutes), `${fmtMin(p.recentMinutes ?? 0)} in the last week`),
      stat('Deck', `${p.deck.total} cards`, `${p.deck.mature} mature · ${p.deck.learning} still learning`),
    ),
    el('div', { class: 'card', style: { marginTop: '14px' } },
      el('div', { class: 'panel-title', text: 'skills · evidence over time' }),
      ...Object.entries(m.skills).map(([k, v]) => el('div', { class: 'radar-row' },
        el('span', { text: k }),
        el('div', { class: 'bar ai' }, el('i', { style: { width: ((indexOf(v.cefr) + v.percentile / 100) / 10) * 100 + '%' } })),
        el('span', { class: 'jp', text: v.cefr }),
      )),
      el('div', { class: 'small muted', style: { marginTop: '10px' }, text: `Overall ${m.overall.cefr} · JLPT estimate ${m.overall.jlptEstimate} · confidence ${Math.round(m.overall.confidence * 100)}%` }),
    ),
    el('div', { class: 'grid two', style: { marginTop: '14px' } },
      el('div', { class: 'card' },
        el('div', { class: 'panel-title', text: 'recurring errors · what the tutor keeps targeting' }),
        p.errors?.length ? el('table', { class: 'tbl' },
          el('thead', {}, el('tr', {}, el('th', { text: 'pattern' }), el('th', { text: 'seen' }), el('th', { text: 'status' }))),
          el('tbody', {}, ...p.errors.map((e) => el('tr', {},
            el('td', {}, el('div', { text: e.label ?? e.tag }), el('div', { class: 'tiny muted', text: e.coach ?? '' })),
            el('td', { text: '×' + e.count }),
            el('td', {}, el('span', { class: 'tag ' + (e.resolved ? 'ok' : 'warn'), text: e.resolved ? 'quiet 10d+' : 'active' })),
          )))) : el('p', { class: 'muted small', text: 'No errors logged yet — they appear as soon as you produce language.' }),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'panel-title', text: 'session history' }),
        el('div', { class: 'spark' }, ...sessions.slice(0, 16).reverse().map((s) => el('i', { style: { height: Math.min(100, (s.minutes ?? 5) * 4) + '%' }, title: `${s.minutes} min` }))),
        el('div', { class: 'small muted', style: { marginTop: '8px' } }, sessions.length ? `Last session ${relTime(sessions[0].started)} · ${sessions[0].minutes} min` : 'No sessions yet.'),
      ),
    ),
    el('div', { class: 'card', style: { marginTop: '14px' } },
      el('div', { class: 'panel-title', text: 'can-do statements · the ones that matter for your goal' }),
      el('div', { class: 'grid two' }, ...(p.cando ?? []).slice(0, 12).map((c) => el('div', { class: 'row gap', style: { alignItems: 'flex-start' } },
        el('span', { class: 'tag ' + (c.status === 'done' ? 'ok' : ''), text: c.level ?? '—' }),
        el('div', {}, el('div', { class: 'small', text: c.statement }), el('div', { class: 'tiny muted', text: c.skill })))),
    ),
  ));
}

function stat(label, big, sub) {
  return el('div', { class: 'card' }, el('div', { class: 'panel-title', text: label }),
    el('div', { style: { fontSize: '26px', fontWeight: 650 }, text: big }),
    el('div', { class: 'small muted', text: sub }));
}

async function renderMemory() {
  const host = $('#memoryBody');
  const d = state.learner;
  if (!d?.model) return;
  const m = d.model;
  host.replaceChildren(
    el('div', { class: 'grid two' },
      el('div', { class: 'card' },
        el('div', { class: 'panel-title', text: 'who the tutor thinks you are' }),
        el('dl', { class: 'kv' },
          el('dt', { text: 'goal' }), el('dd', { text: d.profile.goals.detail || d.profile.goals.primary }),
          el('dt', { text: 'target' }), el('dd', {}, `${d.profile.goals.targetLevel}${d.profile.goals.targetJLPT !== 'none' ? ' / ' + d.profile.goals.targetJLPT : ''}${d.profile.goals.deadlineISO ? ' by ' + d.profile.goals.deadlineISO : ''}`),
          el('dt', { text: 'needed situations' }), el('dd', { text: (d.profile.goals.realSituations ?? []).join(', ') || '—' }),
          el('dt', { text: 'corrections' }), el('dd', { text: `${d.profile.style.correctionTiming} · ${d.profile.style.correctionStyle}` }),
          el('dt', { text: 'L1 support' }), el('dd', { text: d.profile.style.l1Support }),
          el('dt', { text: 'interests' }), el('dd', { text: (d.profile.style.interests ?? []).join(', ') || '—' }),
          el('dt', { text: 'pain points' }), el('dd', { text: (d.profile.style.painPoints ?? []).join('; ') || '—' }),
          el('dt', { text: 'motivation' }), el('dd', { text: d.profile.style.motivationNote || '—' }),
        ),
        el('div', { class: 'row gap', style: { marginTop: '12px' } },
          el('button', { class: 'ghost small', onclick: editPreferences }, 'change correction style'),
        ),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'panel-title', text: 'measured, not claimed' }),
        el('dl', { class: 'kv' },
          el('dt', { text: 'vocabulary' }), el('dd', { text: `≈ ${m.vocabSizeEstimate.toLocaleString()} words` }),
          el('dt', { text: 'kanji' }), el('dd', { text: `${m.kanjiKnown} known · ${m.kanjiLearning} in progress` }),
          el('dt', { text: 'reading speed' }), el('dd', { text: `${m.metrics.readingWPM} wpm` }),
          el('dt', { text: 'native-speed listening' }), el('dd', { text: `${Math.round(m.metrics.listeningAccuracyAtNativeSpeed * 100)}%` }),
          el('dt', { text: 'mean utterance' }), el('dd', { text: `${m.metrics.meanUtteranceLength} chars` }),
          el('dt', { text: 'L1 code-switching' }), el('dd', { text: `${Math.round(m.metrics.codeSwitchRate * 100)}%` }),
          el('dt', { text: 'interaction' }), el('dd', {}, `aizuchi ${m.interactionProfile.aizuchiUse} · questions ${m.interactionProfile.questionForming} · repair ${m.interactionProfile.negotiation}`),
        ),
      ),
    ),
    el('div', { class: 'card', style: { marginTop: '14px' } },
      el('div', { class: 'panel-title', text: 'the tutor’s notebook · what carries between sessions' }),
      (m.notes ?? []).length ? el('div', {}, ...m.notes.slice(-10).reverse().map((n) => el('div', { class: 'small', style: { padding: '7px 0', borderBottom: '1px solid var(--line)' }, text: n }))) : el('p', { class: 'muted small', text: 'Empty. It fills as you work.' }),
      el('div', { class: 'row gap', style: { marginTop: '12px' } },
        el('button', { class: 'soft small', onclick: askTutor }, 'ask why a decision was made'),
      ),
    ),
    el('div', { class: 'card', style: { marginTop: '14px' } },
      el('div', { class: 'panel-title', text: 'the deck' }),
      el('div', { class: 'row gap wrap' },
        el('button', { class: 'soft', onclick: showReview }, `review ${state.due.length} due`),
        el('button', { class: 'ghost', onclick: showClips }, 'hear past you'),
      ),
      el('p', { class: 'small muted', style: { marginTop: '10px' }, text: 'Every card came from something you actually produced or read — never a bulk word list. Scheduling is FSRS-style with a 0.9 target retention, and it gets quietly reinforced inside sessions, not only in reviews.' }),
    ),
  );
}

async function editPreferences() {
  const s = state.profile?.style ?? {};
  modal(el('div', {},
    el('h2', { text: 'How you want to be taught' }),
    el('p', { class: 'small muted', text: 'Corrections during a conversation and corrections afterwards produce similar outcomes — but they feel completely different. This is your call, and the tutor obeys it.' }),
    el('div', { class: 'pills' }, ...[['during', 'as I go'], ['pause', 'pause me'], ['after', 'only at the end']].map(([v, t]) => el('button', {
      class: 'pill' + (s.correctionTiming === v ? ' on' : ''),
      onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); s.correctionTiming = v; },
    }, t))),
    el('div', { class: 'pills', style: { marginTop: '10px' } }, ...[['none', 'Japanese only'], ['hints', 'a few hints'], ['explanations', 'explain in English'], ['lots', 'lots of English']].map(([v, t]) => el('button', {
      class: 'pill' + (s.l1Support === v ? ' on' : ''),
      onclick: (e) => { [...e.target.parentNode.children].forEach((c) => c.classList.toggle('on', c === e.target)); s.l1Support = v; },
    }, t))),
    el('div', { class: 'row gap', style: { marginTop: '16px' } },
      el('button', { class: 'primary', onclick: async () => { await api('/api/learner', { method: 'PATCH', body: { style: s } }); modal(''); await refresh(); toast('Preferences saved.'); } }, 'save'),
      el('button', { class: 'ghost', onclick: () => modal('') }, 'cancel'),
    ),
  ));
}

boot();

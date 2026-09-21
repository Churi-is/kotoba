// session.js — the session runner and one renderer per tool.
//
// The contract: the AI decided *what* this session is (plan + beats). This file is the
// *tools*: it renders whatever beat arrives, emits evidence back, and never assumes a
// particular beat shape beyond what tasks.ts guarantees.

import { api, el, modal, toast, passageNode, ruby, relTime, saveClip, fmtMin } from './api.js';
import { speak, stop as stopAudio, Recorder, canRecord, contour } from './audio.js';
import { startVoiceSession } from './live.js';

const ICON = (k) => el('svg', { class: 'ic' }, el('use', { href: `#i-${k}` }));

export class SessionRunner {
  constructor(opts) {
    this.plan = opts.plan;
    this.meta = opts.meta;
    this.recipe = opts.recipe;
    this.onExit = opts.onExit;
    this.idx = 0;
    this.done = new Set();
    this.events = [];
    this.startedAt = Date.now();
    this.beatAnswers = {};
    this.notebook = [];
  }

  // ------------------------------------------------------------ shell

  render(root) {
    this.root = root;
    this.finishing = false;
    this.finished = false;
    const endButton = document.getElementById('endSession');
    if (endButton) endButton.disabled = false;
    this.renderRail();
    this.stage = el('div', { class: 'stage-inner' });
    root.replaceChildren(this.stage);
    const planned = this.plan.beats.reduce((a, b) => a + (b.minutes || 0), 0) * 60;
    this.timer = el('span', { class: 'timer', title: `planned: ${Math.round(planned / 60)} minutes`, text: '0:00' });
    setInterval(() => {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const mm = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
      this.timer.textContent = planned ? `${mm(s)} / ${mm(planned)}` : mm(s);
      // Past the planned length, say so instead of quietly overrunning: the learner
      // should decide whether to keep going, not discover it afterwards.
      this.timer.classList.toggle('over', Boolean(planned) && s > planned);
      if (planned && s > planned && !this._overNoted) {
        this._overNoted = true;
        toast('That is the planned length. Keep going or wrap up whenever you like — you are in charge.');
      }
    }, 1000);
    this.mount(0);
  }

  renderRail() {
    const list = document.getElementById('beats');
    list.replaceChildren();
    this.plan.beats.forEach((b, i) => {
      const li = el('li', {
        class: (i === this.idx ? 'active ' : '') + (this.done.has(i) ? 'done' : ''),
        onclick: () => this.mount(i),
      },
        el('span', { class: 'bicon' }, ICON(iconFor(b.kind))),
        el('div', {},
          el('div', { class: 'btitle', text: b.titleEN }),
          el('div', { class: 'bmeta', text: `${b.minutes} min · ${b.kind.replace('_', ' ')}` }),
        ),
      );
      list.append(li);
    });
    const meta = document.getElementById('planMeta');
    meta.replaceChildren(
      el('div', { class: 'jp', style: { fontSize: '15px', color: 'var(--ink)' }, text: this.plan.titleJA }),
      el('div', { text: this.plan.titleEN }),
      el('div', { class: 'row gap', style: { marginTop: '8px' } },
        el('span', { class: 'tag', text: `${this.plan.totalMinutes} min` }),
        el('span', { class: 'tag', text: this.recipe ?? this.plan.recipeId }),
        el('span', { class: 'tag ai', text: this.plan.designedBy ?? 'model' }),
      ),
      el('p', { class: 'small muted', style: { marginTop: '10px' }, text: this.plan.rationale }),
    );
  }

  setWhy(text) {
    document.getElementById('whyBody').replaceChildren(
      typeof text === 'string' ? document.createTextNode(text) : text,
    );
  }

  pushNotebook(text) {
    // The same line arriving five times turns the notebook into noise, which is the
    // opposite of its job: it is supposed to be the tutor's memory, not a log.
    const norm = String(text).trim();
    if (!norm) return;
    if (this.notebook.some((n) => n.text === norm)) return;
    this.notebook.push({ text: norm, ts: Date.now() });
    const box = document.getElementById('notebook');
    if (this.notebook.length === 1) box.replaceChildren();
    box.append(el('div', { class: 'small', style: { marginBottom: '7px', color: 'var(--ink-2)' } },
      el('span', { style: { fontFamily: 'var(--jp)' }, text: '葵 ' }), text));
  }

  emit(type, payload, beatId) {
    const ev = { ts: Date.now(), beatId: beatId ?? this.plan.beats[this.idx]?.id, type, payload };
    this.events.push(ev);
    api(`/api/session/${this.plan.id}/event`, { body: ev })
      .then((r) => {
        if (r.adaptationError) toast('Mid-session adjustment failed — staying on plan. (' + r.adaptationError + ')', 5200);
        this.handleAdaptation(r.adaptation);
      })
      .catch(() => {});
  }

  handleAdaptation(ad) {
    if (!ad) return;
    if (ad.action === 'inject' && ad.beat) {
      // The model decided a 3-minute drill is needed; the app supplies the tool.
      this.plan.beats.splice(this.idx + 1, 0, ad.beat);
      this.renderRail();
      toast(`Aoi added a ${ad.beat.minutes}-minute drill: ${ad.reason}`);
      this.setWhy(el('div', {},
        el('div', { style: { color: 'var(--warn)' }, text: `Adjusted mid-session: ${ad.reason}` }),
        el('div', { style: { marginTop: '6px' }, text: ad.beat.why }),
      ));
    } else if (ad.action === 'wrap') {
      this.pushNotebook(`Deciding to wrap up: ${ad.reason}`);
      toast(ad.reason);
    } else if (ad.action === 'replan') {
      this.pushNotebook(`Planning to change approach: ${ad.reason}`);
      toast(`Aoi is changing the plan: ${ad.reason}`);
    }
  }

  go(i) { this.idx = Math.max(0, Math.min(this.plan.beats.length - 1, i)); this.mount(this.idx); }

  // ------------------------------------------------------------ beat mounting

  mount(i) {
    stopAudio();
    this.idx = i;
    const beat = this.plan.beats[i];
    if (!beat) return;
    this.renderRail();
    this.setWhy(el('div', {},
      el('div', { text: beat.why || '—' }),
      beat.scaffolding?.length ? el('div', { class: 'small muted', style: { marginTop: '8px' } },
        'If you stall, I will offer: ', beat.scaffolding.join(' → ')) : null,
      el('div', { class: 'small muted', style: { marginTop: '8px' } },
        `Success looks like: ${beat.success || '—'}`),
    ));

    const apiForBeat = {
      emit: (t, p) => this.emit(t, p, beat.id),
      setWhy: (t) => this.setWhy(t),
      notebook: (t) => this.pushNotebook(t),
      complete: (answers) => this.completeBeat(answers),
      setText: (t) => { this._openText = t; },
      sessionId: this.plan.id,
      meta: this.meta,
      plan: this.plan,
    };

    this.stage.replaceChildren(this.beatHeader(beat), el('div', { class: 'beat-body' }));
    const body = this.stage.querySelector('.beat-body');
    const renderer = RENDERERS[beat.kind] ?? RENDERERS._fallback;
    renderer(beat, body, apiForBeat);
    this.stage.append(this.ratings(beat));
  }

  beatHeader(beat) {
    return el('div', { class: 'stage-head' },
      el('div', {},
        el('h2', { class: 'jp', text: beat.titleJA }),
        el('div', { class: 'row gap wrap', style: { marginTop: '6px' } },
          el('span', { class: 'tag', text: beat.kind.replace('_', ' ') }),
          el('span', { class: 'tag', text: `${beat.minutes} min` }),
          el('span', { class: `tag ${beat.difficulty >= 4 ? 'warn' : ''}`, text: 'difficulty ' + '●'.repeat(beat.difficulty) + '○'.repeat(5 - beat.difficulty) }),
          ...(beat.targets ?? []).slice(0, 4).map((t) => el('span', { class: 'tag shu jp', text: t.surface })),
        ),
        el('p', { class: 'small muted', style: { marginTop: '8px' }, text: beat.objective }),
      ),
      el('div', { class: 'beat-tools' },
        this.timer,
        el('button', {
          class: 'ghost small',
          onclick: () => this.toggleHelp(beat),
        }, 'hint'),
        el('button', {
          class: 'primary small',
          dataset: { ref: 'advance' },
          onclick: () => this.completeBeat(),
        }, this.advanceLabel()),
      ),
    );
  }

  /**
   * The first press marks the activity and shows the feedback; the next one moves on.
   * A button whose label does not change between those two jobs is a button that looks
   * broken, so it is labelled for what it is about to do.
   */
  advanceLabel() {
    const last = this.idx === this.plan.beats.length - 1;
    if (this.done.has(this.idx)) return last ? 'finish session' : 'next →';
    return last ? 'mark & finish' : 'mark & continue →';
  }

  toggleHelp(beat) {
    const hints = beat.scaffolding ?? [];
    this.hintLevel = (this.hintLevel ?? -1) + 1;
    if (this.hintLevel >= hints.length) this.hintLevel = Math.max(0, hints.length - 1);
    this.emit('hint', { level: this.hintLevel + 1 }, beat.id);
    toast(hints[this.hintLevel] ?? 'No hints left — say it however you can.', 5200);
  }

  ratings(beat) {
    const opts = [
      ['too_easy', 'too easy'], ['just_right', 'just right'], ['too_hard', 'too hard'],
      ['lost', "I'm lost"], ['boring', 'boring'], ['more_like_this', 'more like this'],
    ];
    return el('div', { class: 'ratings' },
      el('span', { class: 'small muted', style: { alignSelf: 'center' }, text: 'How was that?' }),
      ...opts.map(([v, label]) => el('button', {
        class: 'ghost', onclick: (e) => {
          e.target.classList.add('soft');
          this.emit('rating', { value: v }, beat.id);
          if (v === 'too_easy' || v === 'too_hard' || v === 'lost') toast('Noted — Aoi can adjust the rest of this session.');
        },
      }, label)),
    );
  }

  // ------------------------------------------------------------ completing a beat

  async completeBeat(answers) {
    const beat = this.plan.beats[this.idx];
    if (!beat) return;
    if (answers) this.beatAnswers[beat.id] = answers;
    if (this.done.has(this.idx)) { this.go(this.idx + 1); return; }

    this.emit('beat_complete', { minutes: beat.minutes }, beat.id);
    this.done.add(this.idx);
    this.renderRail();
    const adv = this.stage.querySelector('[data-ref=advance]');
    if (adv) adv.textContent = this.advanceLabel();

    const marking = el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' Aoi is marking this…');
    this.stage.querySelector('.beat-body')?.append(marking);

    try {
      const { feedback } = await api(`/api/session/${this.plan.id}/beat/${beat.id}/mark`, {
        body: { answers: this.beatAnswers[beat.id] ?? answers, text: beat.openEnded ? (this._openText ?? '') : undefined },
      });
      marking.remove();
      this.showFeedback(feedback);
      if (feedback.notices?.length) {
        this.pushNotebook(`${feedback.notices.length} correction${feedback.notices.length > 1 ? 's' : ''} logged: ${feedback.notices.map((n) => n.tag).join(', ')}`);
      }
      if (feedback.nextTime) this.pushNotebook(feedback.nextTime);
    } catch (err) {
      marking.remove();
      toast('Could not mark that beat — carrying on.');
    }

    const last = this.idx === this.plan.beats.length - 1;
    this.stage.append(el('div', { class: 'row gap', style: { marginTop: '18px' } },
      last
        ? el('button', { class: 'primary', onclick: () => this.finish() }, 'Finish session & see the debrief')
        : el('button', { class: 'primary', onclick: () => this.go(this.idx + 1) }, 'Next activity →'),
      el('button', { class: 'ghost', onclick: () => this.finish() }, 'End session here'),
    ));
  }

  /** Dialogic feedback: show the learner what went wrong and *ask* before telling. */
  showFeedback(fb) {
    const box = el('div', { class: 'card', style: { marginTop: '16px' } });
    box.append(el('h3', { text: fb.achieved || 'Marked' }));
    for (const w of fb.wins ?? []) box.append(el('div', { class: 'win', text: w }));
    for (const n of fb.notices ?? []) {
      const recast = el('div', { class: 'recast jp', style: { display: 'none' } }, '→ ' + n.recast);
      box.append(el('div', { class: 'notice' },
        el('div', { class: 'quote jp', text: '「' + n.quote + '」' }),
        el('div', { class: 'small', text: n.issue }),
        el('div', { class: 'elicit', style: { marginTop: '7px' }, text: n.elicit }),
        recast,
        el('button', {
          class: 'ghost small', style: { marginTop: '8px' },
          onclick: (e) => {
            e.target.remove();
            recast.style.display = 'block';
            this.emit('reveal', { tag: n.tag });
          },
        }, "I don't know — show me"),
        el('div', { class: 'tiny muted', style: { marginTop: '6px' }, text: `logged as ${n.tag}` }),
      ));
    }
    if (fb.targets?.length) {
      box.append(el('div', { class: 'small muted', style: { marginTop: '10px' } },
        'Added to your review deck: ',
        ...fb.targets.map((t) => el('span', { class: 'tag shu jp', text: t.surface + (t.reading ? `（${t.reading}）` : '') })),
      ));
    }
    if (fb.nextTime) box.append(el('p', { class: 'small muted', style: { marginTop: '10px' }, text: fb.nextTime }));
    this.stage.append(box);
  }

  async finish() {
    // A debrief request can take a few seconds. Guard the button while it is in flight;
    // two finish requests used to race, with one deleting the active session while the
    // other was still trying to render it. Keep the runner on screen when generation
    // fails so the learner can retry instead of being sent home with no explanation.
    if (this.finishing || this.finished) return;
    this.finishing = true;
    const endButton = document.getElementById('endSession');
    if (endButton) endButton.disabled = true;

    const status = el('div', { class: 'card debrief-loading' },
      el('div', { class: 'row gap' }, el('span', { class: 'spin' }), el('strong', { text: 'Aoi is writing your debrief…' })),
      el('p', { class: 'small muted', style: { marginTop: '10px' }, text: 'Your answers and conversation are already saved. This usually takes a few seconds.' }),
    );
    this.stage.replaceChildren(status);

    try {
      const result = await api(`/api/session/${this.plan.id}/finish`, { body: {} });
      if (!result?.debrief) throw new Error('The tutor returned an empty debrief. Try again.');
      renderDebrief(this.stage, result.debrief, {
        onExit: this.onExit,
        onAgain: () => this.onExit?.(true),
      });
      this.finishing = false;
      this.finished = true;
      this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      this.finishing = false;
      this.finished = false;
      if (endButton) endButton.disabled = false;
      const message = err?.message || 'The tutor could not build the debrief.';
      this.stage.replaceChildren(el('div', { class: 'card debrief-error' },
        el('div', { class: 'panel-title' }, ICON('info'), 'session wrap-up'),
        el('h2', { text: 'The debrief could not be generated' }),
        el('p', { class: 'muted', text: message }),
        el('p', { class: 'small muted', text: 'Nothing was lost. Your activity evidence is saved, and you can try the debrief again.' }),
        el('div', { class: 'row gap', style: { marginTop: '16px' } },
          el('button', { class: 'primary', onclick: () => this.finish() }, 'Try the debrief again'),
          el('button', { class: 'ghost', onclick: () => this.onExit?.() }, 'Back to today'),
        ),
      ));
    }
  }
}

// ================================================================ renderers

const RENDERERS = {};

/**
 * Fallback for a beat that has nothing to do. Never leave the learner staring at a
 * blank stage: name what happened, and give them the button that moves on.
 */
function shell(beat, root, api, title, body) {
  root.append(
    el('div', { class: 'card', style: { borderColor: 'var(--line-2)' } },
      el('div', { class: 'row between', style: { marginBottom: '8px' } },
        el('strong', { text: title }),
        el('span', { class: 'tag warn', text: 'plan gap' })),
      el('p', { class: 'small muted', text: body }),
      el('button', { class: 'primary small', style: { marginTop: '12px' }, onclick: () => api.complete() }, 'Skip to the next activity →'),
    ),
  );
}

/** Warm-up and quiz: one item at a time, immediate explanatory feedback. */
function renderQuiz(beat, root, api) {
  const items = beat.quiz ?? [];
  if (!items.length) return shell(beat, root, api, 'Nothing to show here',
    'This activity arrived without any items — that is a planner bug, not something you did. Skip it and the next activity picks up where the plan intended.');
  const state = { i: 0, answers: [] };
  const wrap = el('div', { class: 'qbox' });
  root.append(wrap);

  const draw = () => {
    const q = items[state.i];
    const counter = el('div', { class: 'small muted', text: `Question ${state.i + 1} of ${items.length}` });
    const prompt = el('div', { class: 'prompt jp', text: q.prompt.replace(/\\n/g, '\n') });
    const opts = el('div', { class: 'opts' });
    const explain = el('div', { class: 'explain jp' });
    const card = el('div', { class: 'q' }, counter, prompt, opts, explain);
    wrap.replaceChildren(card);

    if (q.audio) {
      opts.append(el('button', {
        class: 'ghost small', style: { marginBottom: '10px' },
        onclick: () => speak(q.audio, {}),
      }, '▶ play audio'));
    }

    let answered = false;
    (q.options ?? ['(no options)']).forEach((opt) => {
      const btn = el('button', { class: 'opt', onclick: () => {
        if (answered) return;
        answered = true;
        const expected = Array.isArray(q.answer) ? q.answer[0] : q.answer;
        const correct = String(opt).trim() === String(expected).trim();
        btn.classList.add(correct ? 'correct' : 'wrong');
        [...opts.children].forEach((c) => {
          if (c.textContent.trim() === String(expected).trim()) c.classList.add('correct');
        });
        explain.replaceChildren(
          el('strong', { text: correct ? '✓ Correct. ' : `✗ Not quite — the answer is ${expected}. ` }),
          document.createTextNode(q.explanation ?? ''),
        );
        state.answers.push({ prompt: q.prompt, expected, given: opt, correct });
        api.emit('answer', { itemId: q.id, given: opt, correct, expected, level: q.level, tags: q.tags });
        setTimeout(() => {
          if (state.i < items.length - 1) { state.i++; draw(); }
          else {
            wrap.append(el('div', { class: 'row gap', style: { marginTop: '14px' } },
              el('button', { class: 'primary small', onclick: () => api.complete(state.answers) }, 'Mark this activity'),
            ));
          }
        }, correct ? 900 : 2400);
      } }, opt);
      opts.append(btn);
    });

    if (!q.options) {
      // open item: accept typed input
      const input = el('input', { type: 'text', placeholder: 'type your answer…', class: 'jp' });
      opts.append(input, el('button', { class: 'soft small', onclick: () => {
        const expected = Array.isArray(q.answer) ? q.answer[0] : q.answer;
        const correct = input.value.trim().replace(/[。、！？\s]/g, '') === String(expected).replace(/[。、！？\s]/g, '');
        explain.replaceChildren(el('strong', { text: correct ? '✓ ' : `✗ Expected: ${expected}. ` }), document.createTextNode(q.explanation ?? ''));
        state.answers.push({ prompt: q.prompt, expected, given: input.value, correct });
        api.emit('answer', { itemId: q.id, given: input.value, correct, expected });
        setTimeout(() => { if (state.i < items.length - 1) { state.i++; draw(); } else api.complete(state.answers); }, 1400);
      } }, 'check'));
    }
  };
  draw();
}
RENDERERS.warmup = renderQuiz;
RENDERERS.quiz = renderQuiz;

/** Reading: i+1 passage, tap any word for a gloss, then comprehension items. */
function renderReading(beat, root, api) {
  const r = beat.reading;
  if (!r) return renderQuiz(beat, root, api);
  const started = Date.now();
  const newWords = (r.glossary ?? []).map((g) => g.surface);
  const p = el('div', { class: 'passage', style: { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '20px' } });

  const tap = async (term, ev) => {
    api.emit('tool', { tool: 'gloss', value: { term } });
    const g = await apiGloss(term, beat);
    const box = el('div', { class: 'gloss' },
      el('div', { class: 'row between' }, el('span', { class: 'w jp', text: term }), el('button', { class: 'iconbtn', onclick: () => box.remove() }, '×')),
      el('div', { class: 'r jp', text: g.reading || '' }),
      el('div', { text: g.meaningEN || g.meaning || '' }),
      g.note ? el('div', { class: 'small muted', style: { marginTop: '6px' }, text: g.note }) : null,
      el('button', { class: 'ghost small', style: { marginTop: '8px' }, onclick: () => speak(g.example || term) }, '▶ hear it'),
    );
    box.style.left = Math.min(window.innerWidth - 350, ev.clientX + 10) + 'px';
    box.style.top = Math.min(window.innerHeight - 230, ev.clientY + 14) + 'px';
    document.body.append(box);
    setTimeout(() => document.addEventListener('click', () => box.remove(), { once: true }), 60);
  };

  p.append(passageNode(r.text, { newWords, onTap: tap }));
  root.append(
    el('div', { class: 'row between', style: { marginBottom: '10px' } },
      el('div', { class: 'row gap' },
        el('button', { class: 'ghost small', onclick: () => speak(r.text) }, '▶ listen while reading'),
        el('span', { class: 'tiny muted', text: 'tap any word for a gloss' }),
      ),
      el('span', { class: 'small muted', text: `${[...r.text].length} characters` }),
    ),
    p,
  );
  if (r.glossary?.length) {
    root.append(el('div', { class: 'row gap wrap', style: { marginTop: '12px' } },
      el('span', { class: 'small muted', text: 'new this passage:' }),
      ...r.glossary.map((g) => el('span', { class: 'tag shu jp', text: `${g.surface}（${g.reading}）= ${g.meaning}` })),
    ));
  }
  const q = el('div', { style: { marginTop: '18px' } });
  root.append(q);
  renderQuiz({ ...beat, quiz: r.questions, reading: undefined }, q, {
    ...api,
    complete: (answers) => {
      const pre = el('div');
      api.emit('rating', { value: 'reading_speed', wpm: 0, seconds: Math.round((Date.now() - started) / 1000) });
      api.complete(answers);
    },
  });
}

/** Listening: gist first, then detail, with a transcript reveal the learner controls. */
function renderListening(beat, root, api) {
  const l = beat.listening;
  if (!l) return renderQuiz(beat, root, api);
  let played = 0;
  const status = el('span', { class: 'small muted', text: 'not played yet' });
  const qbox = el('div', { style: { marginTop: '18px', opacity: .45, pointerEvents: 'none' } });
  const transcript = el('div', { class: 'passage jp', style: { display: 'none', marginTop: '14px', background: 'var(--bg-2)', borderRadius: '12px', padding: '14px' }, text: l.script });

  root.append(el('div', { class: 'card' },
    el('h3', { class: 'jp', text: l.title }),
    el('p', { class: 'small muted', text: 'Listen once for the gist. Do not try to catch every word — that is what the second pass is for.' }),
    el('div', { class: 'row gap wrap' },
      el('button', { class: 'primary', onclick: () => run(1) }, '▶ play'),
      el('button', { class: 'ghost', onclick: () => run(0.85) }, '▶ slower (0.85×)'),
      el('button', { class: 'ghost', onclick: () => run(1.15) }, '▶ faster (1.15×)'),
      status,
    ),
    el('div', { class: 'row gap', style: { marginTop: '12px' } },
      el('button', { class: 'ghost small', onclick: (e) => {
        transcript.style.display = transcript.style.display === 'none' ? 'block' : 'none';
        api.emit('reveal', { tool: 'transcript' });
        e.target.textContent = transcript.style.display === 'none' ? 'show transcript' : 'hide transcript';
      } }, 'show transcript'),
    ),
    transcript,
  ));
  root.append(qbox);

  async function run(rate) {
    played++;
    status.textContent = played === 1 ? 'played once' : `played ${played}×`;
    api.emit('tool', { tool: 'audio_play', value: { rate } });
    await speak(l.script, { rate });
    if (played >= 1) { qbox.style.opacity = 1; qbox.style.pointerEvents = 'auto'; }
  }

  renderQuiz({ ...beat, quiz: l.questions }, qbox, api);
}

// These are real tools, not fallback content. Keep the registrations next to the
// renderer definitions: omitting one makes the runner show its "no renderer" card even
// though the implementation exists below the planner contract.
RENDERERS.reading = renderReading;
RENDERERS.listening = renderListening;

/** Conversation / roleplay / free talk: the actual tutoring, turn by turn. */
function renderChat(beat, root, beatApi) {
  const c = beat.conversation ?? {};
  const history = [];
  const chat = el('div', { class: 'chat' });
  let turns = 0;
  const turnLabel = el('span', { class: 'small muted', text: c.maxTurns ? `0 / ${c.maxTurns} turns` : '0 turns' });

  if (c.setting) {
    root.append(el('div', { class: 'card scenario-card' },
      el('div', { class: 'scenario-topline' },
        el('span', { class: 'scenario-kicker', text: 'text chat simulation' }),
        turnLabel,
      ),
      el('h3', { class: 'scenario-title', text: c.setting }),
      el('div', { class: 'scenario-roles' },
        el('div', { class: 'scenario-role' },
          el('span', { class: 'scenario-role-label', text: 'You are' }),
          el('span', { text: c.learnerRole || 'the learner' }),
        ),
        el('div', { class: 'scenario-role' },
          el('span', { class: 'scenario-role-label', text: 'Aoi is' }),
          el('span', { text: c.tutorRole || 'your tutor' }),
        ),
      ),
      el('div', { class: 'scenario-goal' },
        el('strong', { class: 'small', text: 'Your goal' }),
        el('span', { class: 'small', text: c.learnerGoal || 'Keep the conversation going.' }),
      ),
      c.constraints?.length ? el('div', { class: 'row gap wrap scenario-constraints' },
        ...c.constraints.map((x) => el('span', { class: 'tag warn', text: x }))) : null,
    ));
  }

  const add = (role, text) => {
    const bubble = el('div', { class: 'bubble' }, el('span', { class: 'jp' }, ...textLines(text)));
    chat.append(el('div', { class: 'msg ' + role }, el('span', { class: 'avatar', text: role === 'tutor' ? '葵' : 'you' }), bubble));
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  };

  const input = el('textarea', { class: 'jp', rows: 2, placeholder: '日本語で 書いてみてください…' });
  const send = el('button', { class: 'primary', onclick: () => submit() }, 'send');

  const mic = canRecord() ? el('button', { class: 'micbtn', title: 'record your answer', onclick: () => record() }, ICON('mic')) : null;

  async function record() {
    const rec = new Recorder();
    mic.classList.add('rec');
    try {
      await rec.start();
      const done = await new Promise((resolve) => {
        mic.onclick = async () => { mic.onclick = () => record(); resolve(await rec.stop()); };
        setTimeout(async () => { if (mic.classList.contains('rec')) { mic.onclick = () => record(); resolve(await rec.stop()); } }, 12000);
      });
      mic.classList.remove('rec');
      if (!done) return;
      await saveClip({ id: `beat-${beat.id}-${Date.now()}`, ts: Date.now(), label: beat.titleEN, blob: done.blob });
      const bars = await contour(done.blob);
      chat.append(el('div', { class: 'msg learner' }, el('span', { class: 'avatar', text: 'you' }),
        el('div', { class: 'bubble' },
          el('div', { class: 'small', text: `🎙 recorded ${Math.round(done.ms / 1000)}s — saved to your local archive` }),
          el('div', { class: 'pitchviz' }, ...bars.map((v) => el('i', { style: { height: v + '%' } }))),
          el('div', { class: 'tiny muted', text: 'That trace is your loudness contour: useful for mora timing and phrase-final fall. Aoi will comment on the substance once you type or send it.' }),
          el('button', { class: 'ghost small', style: { marginTop: '8px' }, onclick: () => { const a = new Audio(done.url); a.play(); } }, '▶ hear yourself'),
        )));
      toast('Recording saved locally. Type what you said so Aoi can mark it — or start a voice session below.');
    } catch {
      mic.classList.remove('rec');
      toast('No mic access — typing works fine.');
    }
  }

  async function submit(preset) {
    const text = preset ?? input.value.trim();
    if (!text) return;
    input.value = '';
    add('learner', text);
    if (!preset) beatApi.emit('utterance', { text });
    turns++;
    turnLabel.textContent = c.maxTurns ? `${turns} / ${c.maxTurns} turns` : `${turns} turns`;
    const thinking = add('tutor', '…');
    try {
      const r = await api(`/api/session/${beatApi.sessionId}/turn`, { body: { beatId: beat.id, text } });
      thinking.replaceChildren(el('span', { class: 'jp' }, ...textLines(r.reply)));
      history.push({ role: 'learner', text }, { role: 'tutor', text: r.reply });
    } catch (e) {
      thinking.replaceChildren(el('span', { class: 'small', style: { color: 'var(--bad)' }, text: `⚠ tutor error: ${e.message || 'the tutor could not answer'}` }));
    }
    if (c.maxTurns && turns >= c.maxTurns) {
      root.append(el('div', { class: 'row gap', style: { marginTop: '14px' } },
        el('button', { class: 'primary', onclick: () => beatApi.complete() }, 'Wrap up this scene'),
      ));
    }
  }

  root.append(chat, el('div', { class: 'composer' }, input, mic, send));
  add('tutor', c.openingLine ?? 'こんにちは。今日は 何を しましょうか。');
  if (c.openingTranslation) root.append(el('div', { class: 'tiny muted', style: { marginTop: '6px' }, text: c.openingTranslation }));
  root.append(el('div', { class: 'row gap wrap', style: { marginTop: '12px' } },
    el('button', { class: 'soft small', onclick: () => startVoice(beat, beatApi, chat) }, '🎧 voice mode (hands-free)'),
    el('button', { class: 'ghost small', onclick: () => {
      const h = (beat.scaffolding ?? [])[0] ?? 'Say it simply: subject + を + verb.';
      root.append(el('div', { class: 'hint jp' }, h));
      beatApi.emit('hint', { level: 1 });
    } }, 'I’m stuck'),
    el('button', { class: 'ghost small', onclick: () => {
      const phrase = (beat.targets ?? [])[0]?.surface;
      input.value = phrase ? `${phrase}を お願いします。` : 'すみません、もう一度 お願いします。';
      input.focus();
    } }, 'give me a starter phrase'),
  ));
}
RENDERERS.conversation = renderChat;
RENDERERS.roleplay = renderChat;
RENDERERS.free_talk = renderChat;

async function startVoice(beat, api, chat) {
  try {
    const info = await apiPost('/api/live/start', { sessionId: api.sessionId, beatId: beat.id });
    if (!info.wsPath) throw new Error('the server did not offer a voice session');
    await startVoiceSession({
      wsPath: info.wsPath,
      model: info.model,
      onTutor: (t) => { const b = el('div', { class: 'msg tutor' }, el('span', { class: 'avatar', text: '葵' }), el('div', { class: 'bubble jp', text: t })); chat.append(b); chat.scrollTop = chat.scrollHeight; },
      onLearner: (t) => { const b = el('div', { class: 'msg learner' }, el('span', { class: 'avatar', text: 'you' }), el('div', { class: 'bubble jp', text: t })); chat.append(b); chat.scrollTop = chat.scrollHeight; },
      onError: (m) => toast(m, 5000),
    });
  } catch (e) {
    toast(e.message || 'Voice mode is unavailable right now.', 6000);
  }
}

/** Shadowing / pronunciation: copy the rhythm, then look at what you produced. */
function renderShadowing(beat, root, api) {
  const lines = beat.lines ?? [];
  root.append(el('p', { class: 'small muted', text: 'Listen first, then speak *with* the audio — not after it. Tap the syllables as you go.' }));
  lines.forEach((ln, i) => {
    const card = el('div', { class: 'line-card' },
      el('div', { class: 'ja jp', text: ln.ja }),
      el('div', { class: 'rd jp', text: ln.reading }),
      el('div', { class: 'en', text: ln.en }),
      el('div', { class: 'focus', text: '🎯 ' + ln.focus }),
      el('div', { class: 'row gap wrap', style: { marginTop: '10px' } },
        el('button', { class: 'ghost small', onclick: () => speak(ln.ja, {}) }, '▶ normal'),
        el('button', { class: 'ghost small', onclick: () => speak(ln.ja, { rate: 0.8 }) }, '▶ slow'),
        el('button', { class: 'soft small', onclick: () => selfCheck(card, ln) }, '✓ I matched it'),
      ),
    );
    root.append(card);
  });
  root.append(el('div', { class: 'row gap', style: { marginTop: '6px' } },
    el('button', { class: 'primary small', onclick: () => api.complete() }, 'Mark this activity'),
  ));

  async function selfCheck(card, ln) {
    card.classList.add('target');
    api.emit('utterance', { text: ln.ja, selfRated: true });
    if (!canRecord()) { toast('Nice. (No mic — self-rating recorded as evidence.)'); return; }
    const rec = new Recorder();
    try {
      await rec.start();
      toast('Recording — say the line, then press ✓ again.');
    } catch { toast('Mic blocked — self-rating stands.'); }
  }
}
RENDERERS.shadowing = renderShadowing;
RENDERERS.pronunciation = renderShadowing;

/** Kanji lab: components → word → production check. */
function renderKanji(beat, root, api) {
  const list = beat.kanji ?? [];
  const answers = [];
  list.forEach((k) => {
    root.append(el('div', { class: 'card' },
      el('div', { class: 'kanji-card' },
        el('div', { class: 'big', text: k.char }),
        el('div', {},
          el('div', {}, el('strong', { text: k.meaning })),
          el('div', { class: 'small muted jp', text: `音: ${(k.onyomi ?? []).join('・') || '—'}  ／  訓: ${(k.kunyomi ?? []).join('・') || '—'}` }),
          el('div', { class: 'hint', style: { marginTop: '10px' }, text: k.mnemonic }),
          el('div', { class: 'row gap wrap', style: { marginTop: '10px' } },
            ...(k.words ?? []).map((w) => el('button', { class: 'tag jp soft', onclick: () => speak(w.ja) }, `${w.ja}（${w.reading}）= ${w.en}`))),
        ),
      ),
      productionCheck(k, answers, api),
    ));
  });
  root.append(el('button', { class: 'primary', style: { marginTop: '10px' }, onclick: () => api.complete(answers) }, 'Mark this activity'));
}

function productionCheck(k, answers, api) {
  const wrap = el('div', { style: { marginTop: '14px' } });
  const modes = shuffle(['meaning', 'reading', 'word']);
  const mode = modes[0];
  const q = mode === 'meaning' ? `What does 「${k.char}」 mean?`
    : mode === 'reading' ? `How do you read 「${(k.words ?? [{}])[0].ja}」?`
      : `Which word uses 「${k.char}」?`;
  const expected = mode === 'meaning' ? k.meaning : mode === 'reading' ? (k.words ?? [{}])[0].reading : (k.words ?? [{}])[0].ja;
  const input = el('input', { type: 'text', class: 'jp', placeholder: 'type from memory…' });
  wrap.append(el('div', { class: 'small', text: q }), el('div', { class: 'row gap', style: { marginTop: '8px' } },
    input,
    el('button', { class: 'soft small', onclick: () => {
      const given = input.value.trim();
      const correct = given && (expected.includes(given) || given.includes(expected));
      answers.push({ prompt: q, expected, given, correct });
      api.emit('answer', { itemId: k.char, given, expected, correct, tags: ['kanji'] });
      wrap.append(el('div', { class: 'explain', text: correct ? '✓ Correct.' : `✗ ${expected}` }));
    } }, 'check'),
  ));
  return wrap;
}

/** Noticing grammar: flood → discover → explain. Never explain first. */
function renderGrammar(beat, root, api) {
  const g = beat.grammarPoint ?? {};
  const answers = [];
  const mark = (sentence) => {
    const inner = String(sentence);
    const pattern = (g.pattern ?? '').replace(/[N V〜]/g, '');
    const frag = document.createDocumentFragment();
    if (pattern && inner.includes(pattern)) {
      const [a, ...rest] = inner.split(pattern);
      frag.append(a, el('mark', {}, pattern), rest.join(pattern));
    } else frag.append(inner);
    return frag;
  };

  root.append(el('div', { class: 'card' },
    el('div', { class: 'panel-title', text: '1 · Read these — what is the same?' }),
    el('div', { class: 'flood jp' }, ...(g.inputFlood ?? []).map((s) => el('div', {}, mark(s)))),
    el('div', { class: 'panel-title', style: { marginTop: '16px' }, text: '2 · What do you notice?' }),
    el('div', { class: 'row gap wrap' },
      el('button', { class: 'soft small', onclick: (e) => {
        e.target.classList.add('on');
        root.append(el('div', { class: 'hint', text: 'Good. Look at the part before it — that is what decides the form. Say your guess out loud, then check.' }));
        api.emit('answer', { itemId: 'discovery', given: 'noticed', correct: true, tags: ['grammar', 'noticing'] });
      } }, 'I can see the pattern'),
      el('button', { class: 'ghost small', onclick: () => root.append(el('div', { class: 'hint', text: 'Try: what sits directly before the bold part? A verb? A noun? Change it and see what breaks.' })) }, 'give me a nudge'),
    ),
    el('div', { class: 'panel-title', style: { marginTop: '16px' }, text: '3 · The rule, in plain English' }),
    el('div', { class: 'hint' },
      el('strong', { class: 'jp', text: g.pattern ?? '' }), ' — ', g.explanationEN ?? '',
      el('div', { class: 'small', style: { marginTop: '8px' }, text: 'The classic mistake: ' + (g.commonError ?? '—') }),
    ),
    el('div', { class: 'panel-title', style: { marginTop: '16px' }, text: '4 · Now produce it' }),
  ));

  (g.examples ?? []).slice(0, 2).forEach((ex) => {
    const input = el('input', { type: 'text', class: 'jp', placeholder: 'your own sentence…' });
    root.append(el('div', { class: 'row gap', style: { marginBottom: '8px' } }, input,
      el('button', { class: 'soft small', onclick: () => {
        const t = input.value.trim();
        answers.push({ prompt: `Produce: ${ex.en}`, expected: ex.ja, given: t, correct: t.length > 4 });
        api.emit('utterance', { text: t });
      } }, 'submit my sentence')));
  });
  root.append(el('button', { class: 'primary small', style: { marginTop: '10px' }, onclick: () => api.complete(answers) }, 'Mark this activity'));
}

/** Open production, marked against a published rubric. */
function renderOpen(beat, root, api) {
  const o = beat.openEnded ?? {};
  const area = el('textarea', { class: 'jp', rows: 6, placeholder: '書いてみましょう…' });
  const count = el('span', { class: 'small muted', text: `0 / ${o.minLength ?? 30}` });
  area.oninput = () => { count.textContent = `${area.value.length} / ${o.minLength ?? 30}`; };
  root.append(el('div', { class: 'card' },
    el('div', { class: 'prompt jp', text: o.promptJA ?? '' }),
    el('p', { class: 'small muted', text: o.promptEN ?? '' }),
    area,
    el('div', { class: 'row between', style: { marginTop: '8px' } }, count,
      el('div', { class: 'row gap' },
        el('button', { class: 'ghost small', onclick: () => { area.value = (o.hints ?? []).join(' / '); } }, 'hint'),
        el('button', { class: 'primary small', onclick: () => { api.setText(area.value); api.emit('utterance', { text: area.value }); api.complete(); } }, 'submit for marking'),
      )),
    el('div', { class: 'panel-title', style: { marginTop: '16px' }, text: 'What I will mark you on' }),
    el('div', { class: 'row gap wrap' }, ...(o.rubric ?? []).map((r) => el('span', { class: 'tag', text: `${r.criterion} ${Math.round(r.weight * 100)}%` }))),
  ));
}

/** Register switching — the same message across politeness levels. */
function renderRegister(beat, root, api) {
  const base = beat.extra?.content ?? (beat.targets?.[0]?.surface ?? '明日、伺います。');
  const out = el('div');
  root.append(el('div', { class: 'card' },
    el('div', { class: 'prompt jp', text: base }),
    el('p', { class: 'small muted', text: 'Japanese politeness is a system, not a vocabulary list. Watch what changes structurally.' }),
    el('button', { class: 'primary small', onclick: async (e) => {
      e.target.disabled = true;
      const r = await apiPost('/api/tools/register', { content: base, registers: beat.extra?.registers ?? ['casual', 'polite', 'honorific', 'humble'] });
      out.replaceChildren(el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, el('th', { text: 'register' }), el('th', { text: 'how it sounds' }), el('th', { text: 'what changed' }))),
        el('tbody', {}, ...(r.items ?? []).map((it) => el('tr', {},
          el('td', {}, el('span', { class: 'tag', text: it.register })),
          el('td', { class: 'jp', style: { fontSize: '16px' } }, it.ja, it.en ? el('div', { class: 'small muted', text: it.en }) : null),
          el('td', { class: 'small muted', text: it.note }),
        )))));
    } }, 'show me all registers'),
    out,
  ));
  root.append(el('button', { class: 'primary small', style: { marginTop: '12px' }, onclick: () => api.complete() }, 'Mark this activity'));
}

/** Story mode: serialised extensive reading. */
function renderStory(beat, root, api) {
  const box = el('div', { class: 'card' }, el('span', { class: 'spin' }), ' Aoi is writing today’s episode…');
  root.append(box);
  apiPost('/api/tools/story', {}).then(({ story }) => {
    const p = el('div', { class: 'passage' });
    p.append(passageNode(story.text, { newWords: (story.glossary ?? []).map((g) => g.surface), onTap: async (term, ev) => {
      const g = await apiGloss(term, beat);
      const b = el('div', { class: 'gloss' }, el('div', { class: 'w jp', text: term }), el('div', { class: 'r jp', text: g.reading }), el('div', { text: g.meaningEN }));
      b.style.left = Math.min(window.innerWidth - 340, ev.clientX) + 'px';
      b.style.top = ev.clientY + 12 + 'px';
      document.body.append(b);
      setTimeout(() => document.addEventListener('click', () => b.remove(), { once: true }), 50);
    } }));
    box.replaceChildren(
      el('h3', { class: 'jp', text: story.titleJA }), el('div', { class: 'small muted', text: story.titleEN }),
      el('div', { class: 'row gap', style: { margin: '10px 0' } }, el('button', { class: 'ghost small', onclick: () => speak(story.text) }, '▶ listen to the episode')),
      p,
      story.glossary?.length ? el('div', { class: 'row gap wrap', style: { marginTop: '10px' } }, ...story.glossary.map((g) => el('span', { class: 'tag shu jp', text: `${g.surface}（${g.reading}）` }))) : null,
      story.hook ? el('div', { class: 'hint', text: story.hook }) : null,
      el('div', { style: { marginTop: '14px' } }, el('div', { class: 'q' },
        el('div', { class: 'prompt jp', text: story.question?.prompt ?? '' }),
        el('div', { class: 'opts' }, ...(story.question?.options ?? []).map((o) => el('button', {
          class: 'opt', onclick: (e) => {
            const correct = o === story.question.answer;
            e.target.classList.add(correct ? 'correct' : 'wrong');
            api.emit('answer', { itemId: 'story', given: o, expected: story.question.answer, correct, tags: ['reading'] });
          },
        }, o))))),
      el('button', { class: 'primary small', style: { marginTop: '14px' }, onclick: () => api.complete() }, 'Mark this activity'),
    );
  }).catch(() => box.replaceChildren(el('p', { class: 'muted', text: 'Story generation failed — try again, or carry on.' })));
}

/** Two-way translation, marked on naturalness rather than literal accuracy. */
function renderTranslation(beat, root, api) {
  const items = beat.extra?.items ?? [];
  const answers = [];
  root.append(el('p', { class: 'small muted', text: 'Natural beats literal. A translator who is technically right but sounds like a textbook has failed the task.' }));
  items.forEach((it, i) => {
    const area = el('textarea', { class: 'jp', rows: 3, placeholder: 'translate…' });
    root.append(el('div', { class: 'card' },
      el('div', { class: 'panel-title', text: `item ${i + 1}` }),
      el('div', { class: 'prompt jp', text: it.source }),
      area,
      el('div', { class: 'row gap', style: { marginTop: '8px' } },
        el('button', { class: 'ghost small', onclick: (e) => {
          e.target.after(el('div', { class: 'explain jp', text: 'Reference: ' + (it.reference || '— (needs a model key for references)') }));
          api.emit('reveal', { item: i });
        } }, 'show reference'),
        el('button', { class: 'soft small', onclick: () => {
          answers.push({ prompt: it.source, expected: it.reference ?? '', given: area.value, correct: false });
          api.emit('utterance', { text: area.value });
          toast('Saved — Aoi will mark naturalness, not word-for-word accuracy.');
        } }, 'submit'),
      )));
  });
  root.append(el('button', { class: 'primary small', style: { marginTop: '12px' }, onclick: () => api.complete(answers) }, 'Mark this activity'));
}

RENDERERS.kanji_lab = renderKanji;
RENDERERS.grammar_focus = renderGrammar;
RENDERERS.open_ended = renderOpen;
RENDERERS.register = renderRegister;
RENDERERS.story = renderStory;
RENDERERS.translation = renderTranslation;
RENDERERS.recap = (beat, root, api) => {
  root.append(el('div', { class: 'card' },
    el('h3', { text: 'Wrapping up' }),
    el('p', { class: 'muted', text: 'Let’s look at what actually changed today — not a score, but the things you will say differently next time.' }),
    el('button', { class: 'primary', onclick: () => api.complete() }, 'Show me the debrief'),
  ));
};
RENDERERS._fallback = (beat, root, api) => {
  root.append(el('div', { class: 'card' },
    el('p', { class: 'muted', text: `This activity type (${beat.kind}) has no renderer yet. The tutor still has everything it needs to mark you.` }),
    el('button', { class: 'primary small', onclick: () => api.complete() }, 'Continue'),
  ));
};

// ---------------------------------------------------------------- debrief screen

export function renderDebrief(root, d, { onExit, onAgain } = {}) {
  root.replaceChildren(el('div', { class: 'card' },
    el('div', { class: 'panel-title', text: 'session debrief' }),
    el('h2', { text: d.headline }),
    ...(d.highlights ?? []).map((h) => el('div', { class: 'win jp', text: h })),
    (d.toKeep ?? []).length ? el('div', {},
      el('div', { class: 'panel-title', style: { marginTop: '18px' }, text: `${d.toKeep.length} thing${d.toKeep.length > 1 ? 's' : ''} to keep` }),
      ...d.toKeep.map((n) => el('div', { class: 'notice' },
        el('div', { class: 'quote jp', text: '「' + n.quote + '」' }),
        el('div', { class: 'recast jp', text: '→ ' + n.recast }),
        n.elicit ? el('div', { class: 'elicit jp', text: n.elicit }) : null,
        el('div', { class: 'tiny muted', text: n.tag }),
      )),
    ) : null,
    (d.newCards ?? []).length ? el('div', { style: { marginTop: '16px' } },
      el('div', { class: 'panel-title', text: 'added to your review deck' }),
      el('div', { class: 'row gap wrap' }, ...d.newCards.map((c) => el('span', { class: 'tag shu jp', text: `${c.surface}（${c.reading}）` }))),
    ) : null,
    d.nextTeaser ? el('div', { class: 'hint', style: { marginTop: '18px' } }, el('strong', { text: 'Next time: ' }), d.nextTeaser) : null,
    el('div', { class: 'row gap', style: { marginTop: '20px' } },
      el('button', { class: 'primary', onclick: () => onAgain?.() }, 'Another session'),
      el('button', { class: 'ghost', onclick: () => onExit?.() }, 'Done for today'),
    ),
  ));
}

// ---------------------------------------------------------------- shared helpers

function iconFor(kind) {
  return {
    warmup: 'bolt', conversation: 'chat', quiz: 'check', open_ended: 'pen', reading: 'book',
    listening: 'ear', shadowing: 'wave', pronunciation: 'mic', kanji_lab: 'kanji',
    grammar_focus: 'target', translation: 'swap', roleplay: 'mask', register: 'levels',
    story: 'sparkle', free_talk: 'coffee', recap: 'flag',
  }[kind] ?? 'check';
}

function textLines(text) {
  return String(text ?? '').split('\n').flatMap((line, i) => (i ? [el('br'), line] : [line]));
}

function shuffle(a) { return [...a].sort(() => Math.random() - 0.5); }

const glossCache = new Map();
async function apiGloss(term, beat) {
  if (glossCache.has(term)) return glossCache.get(term);
  const local = (beat.reading?.glossary ?? []).find((g) => g.surface.includes(term) || term.includes(g.surface));
  if (local) { glossCache.set(term, local); return local; }
  try {
    const g = await api('/api/tools/gloss', { body: { term, context: beat.reading?.text?.slice(0, 200) } });
    glossCache.set(term, g);
    return g;
  } catch {
    return { reading: '', meaningEN: '(lookup failed)', note: '' };
  }
}

async function apiPost(path, body) { return api(path, { body }); }

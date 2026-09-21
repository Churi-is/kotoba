/**
 * mock.ts — a scripted tutor that runs the same contract as Gemini.
 *
 * Why bother: (1) the app must be demoable, testable and free to run without a key;
 * (2) during a live model outage the learner should get a degraded session, never a
 * dead end; (3) it is the regression baseline — if the mock tutor produces a valid
 * plan, the schema and validation gates are sane.
 *
 * It is honestly labelled in the UI ("scripted tutor — no model key configured") so
 * nobody mistakes template output for a real tutor.
 */

import type { Beat, Env, Feedback, LearnerModel, Notice, Profile, SessionPlan, Target } from '../types';
import { VOCAB, GRAMMAR, KANJI, SCENARIOS, READING_PASSAGES, LISTENING_CLIPS, CANDO, type SeedScenario } from '../content/seed';
import { errorTag, cefrIndex, cefrAt, newCard, skillRank } from '../domain/pedagogy';
import type { PlanRequest } from './prompts';
import { SESSION_RECIPES } from '../domain/pedagogy';

const rid = (p: string) => `${p}.${Math.random().toString(36).slice(2, 8)}`;

/** ------------------------------------------------------------------ heuristics */

/** Cheap, high-precision-ish error detection. Deliberately conservative: a false
 *  correction is much more damaging than a missed one. */
export function detectIssues(text: string, level: string): Notice[] {
  const out: Notice[] = [];
  const add = (quote: string, tag: string, issue: string, recast: string, elicit: string, severity: 1 | 2 | 3 = 2) =>
    out.push({ quote, tag, issue, recast, elicit, severity });

  if (/[A-Za-z]{3,}/.test(text) && !/^(https?|\/)/.test(text)) {
    const word = (text.match(/[A-Za-z]{3,}/g) ?? [])[0];
    add(text.trim().slice(0, 60), 'l1.codeswitch', `You switched to English with "${word}".`,
      'Try 「〜は 日本語で 何ですか」 or 「もう一度 お願いします」 instead.',
      'あの言葉、日本語で どう言いますか？', 2);
  }
  const teForm = text.match(/(行|来|し|食べ|飲み|読み)(い|る|く)?て[、。\s]/);
  if (teForm && level !== 'pre-A1') {
    add(teForm[0], 'verb.te_form', 'The て-form here follows a rule that does not apply to this verb group.',
      '行く→行って, 食べる→食べて, する→して.', 'この動詞の て-form、どう なりますか？', 2);
  }
  if (/(私|僕|俺)(は|も)[^。]{0,8}(好き|欲しい|上手|下手|分かる|できる|ほしい)/.test(text)) {
    add(text.trim().slice(0, 60), 'particle.wa_ga', 'With 好き/分かる/できる, the thing you like or can do takes が — not は.',
      '私は寿司が好きです。', '「すし」の あとは、は ですか、が ですか？', 2);
  }
  if (/(食べ|飲み|読み|書き|買い|使い|待ち|見|聞き)(ます|ました|たい|ますか)/.test(text) && !/を/.test(text) && level !== 'pre-A1') {
    add(text.trim().slice(0, 60), 'particle.wo_drop', 'That verb needs its object marked with を.',
      '（例）コーヒーを飲みます。', 'この動詞の 前の ことばに、どの 助詞が つきますか？', 2);
  }
  if (/(いらっしゃい|おっしゃい|ご覧になり)/.test(text) && /(私|僕|俺)が?/.test(text.split(/(いらっしゃい|おっしゃい|ご覧になり)/)[0])) {
    add(text.trim().slice(0, 60), 'keigo.honorific', '尊敬語 raises the *other* person. Using it about yourself sounds wrong — almost like a joke.',
      '明日、私が伺います。', '自分の 行動を ひくく 言う 形は、何ですか？', 3);
  }
  if (/(参り|伺い|申し)/.test(text) && /(部長|先生|社長|お客様|お客さん)(が|は|も)/.test(text)) {
    add(text.trim().slice(0, 60), 'keigo.humble', 'That is a humble form, so it cannot describe the other person’s action.',
      '部長は明日いらっしゃいます。', '部長の 行動には、どの 形を 使いますか？', 3);
  }
  if (/(ます|ました|です)/.test(text) && /(だよ|だね|だろ|じゃん|〜だ[。、])/.test(text) && level !== 'pre-A1') {
    add(text.trim().slice(0, 60), 'verb.politeness', 'You mixed polite and plain forms in one turn. Japanese listeners notice this immediately.',
      'Pick one register for the whole turn.', 'この 文、です・ます の 形に そろえると どう なりますか？', 2);
  }
  if (/(ます|ました)(と|と思|つもり)/.test(text)) {
    add(text.trim().slice(0, 60), 'wordorder', 'Before 〜と思います, the quoted clause goes into plain form.',
      '行くと思います（✗ 行きますと思います）', '「行く」と「行きます」、どちらが 正しいですか？', 2);
  }
  if (/はし|かみ|あめ/.test(text) === false && /箸|橋/.test(text) === false) {
    /* nothing — pitch can only be judged from audio, which the voice path handles */
  }
  return out.slice(0, 3);
}

function countCodeSwitch(text: string) {
  const words = text.trim().split(/\s+/);
  const latin = words.filter((w) => /^[A-Za-z]{2,}/.test(w)).length;
  return words.length ? latin / words.length : 0;
}

/** ------------------------------------------------------------------ beat builders */

function vocabOfLevel(level: string, n: number): Target[] {
  return VOCAB.filter((v) => v.level === level).slice(0, n).map((v) => ({
    kind: 'vocab' as const, id: v.id, surface: v.surface, reading: v.reading, meaning: v.en, note: v.example,
  }));
}

/** Distractors drawn from the same part of speech or topic, not from file order. */
function plausibleOthers(v: (typeof VOCAB)[number], pool: typeof VOCAB, n = 3): typeof VOCAB {
  const rank = (x: (typeof VOCAB)[number]) =>
    (x.tags ?? []).some((t) => (v.tags ?? []).includes(t)) ? 0 : x.pos === v.pos ? 1 : x.level === v.level ? 2 : 3;
  return pool
    .filter((x) => x.id !== v.id && x.en !== v.en)
    .map((x) => ({ x, r: rank(x) + Math.random() * 0.6 }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((o) => o.x);
}

function quizFromVocab(level: string, n: number, mode: 'meaning' | 'reading' | 'particle'): Beat['quiz'] {
  const pool = VOCAB.filter((v) => v.level === level);
  const others = VOCAB.filter((v) => v.level !== level);
  return pool.slice(0, n).map((v, i) => {
    if (mode === 'meaning') {
      const distract = plausibleOthers(v, [...pool, ...others]).map((o) => o.en);
      return {
        id: rid('q'), prompt: `「${v.surface}」 is closest to…`,
        options: shuffle([v.en, ...distract]), answer: v.en,
        explanation: `${v.surface}（${v.reading}） means “${v.en}”. In context: ${v.example}`, tags: ['vocab'], level: v.level, targetIds: [v.id],
      };
    }
    if (mode === 'reading') {
      const distract = plausibleOthers(v, [...pool, ...others]).map((o) => o.reading);
      return {
        id: rid('q'), prompt: `How do you read 「${v.surface}」?`,
        options: shuffle([v.reading, ...distract]), answer: v.reading,
        explanation: `${v.surface} = ${v.reading}. Example: ${v.example}`, tags: ['reading', 'kanji'], level: v.level, targetIds: [v.id],
      };
    }
    const g = GRAMMAR.filter((x) => x.level === level)[i % Math.max(1, GRAMMAR.filter((x) => x.level === level).length)];
    return {
      id: rid('q'), prompt: `Choose the particle: ${(g?.example ?? '水＿＿飲みます。').replace(g?.pattern ?? '', '＿＿')}`,
      options: ['を', 'は', 'に', 'で'], answer: 'を',
      explanation: `Transitive verb → を marks the object. ${g?.example ?? ''}`, tags: ['particle'], level: v.level, targetIds: [v.id],
    };
  });
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function scenarioFor(level: string, hint?: string): SeedScenario {
  const band = ['A1', 'A1+', 'A2.1', 'A2', 'B1', 'B2'];
  const i = band.indexOf(level as any);
  const window = i < 0 ? 2 : i;
  const candidates = SCENARIOS.filter((s) => Math.abs(band.indexOf(s.level) - window) <= 1);
  const pool = candidates.length ? candidates : SCENARIOS;
  if (hint === 'speaking') return pool.find((s) => s.tags.includes('high_value')) ?? pool[0];
  return pool[Math.floor(Math.random() * pool.length)];
}

export function buildConversationBeat(level: string, minutes: number, hint?: string, targets?: Target[]): Beat {
  const s = scenarioFor(level, hint);
  const t = targets?.length ? targets.slice(0, 3) : vocabOfLevel(level, 3);
  const opener = {
    A1: `いらっしゃいませ。こんにちは！`,
    'A1+': `いらっしゃいませ。ご注文は お決まりですか？`,
    'A2.1': `はい、もしもし。ご予約の お電話ですね。`,
    A2: `あ、来た来た！ 元気だった？`,
    B1: `おはようございます。今日は ちょっと お願いが あるんですが。`,
    B2: `おはようございます。例の件ですが、少し お話ししても よろしいでしょうか。`,
  }[level] ?? 'こんにちは。';
  return {
    id: rid('b'),
    kind: 'roleplay',
    minutes,
    titleJA: s.title,
    titleEN: s.titleEN,
    objective: `Handle "${s.titleEN}" using ${t.map((x) => x.surface).join(' / ')}`,
    why: `This is exactly the kind of exchange you told me you need. Your target items get used under mild time pressure — that is what makes them stay.`,
    targets: t,
    success: s.mustDo.join(' AND '),
    difficulty: (Math.min(5, Math.max(1, cefrIndex(level as any) / 2 + 1)) as 1 | 2 | 3 | 4 | 5),
    scaffolding: [`Remember: 「${t[0]?.surface ?? 'お願いします'}」 puts you back on track.`, `Try starting with 「すみません、〜」`, `Model answer: ${t[0] ? `${t[0].surface}を お願いします。` : 'お願いします。'}`],
    mode: 'voice',
    conversation: {
      setting: s.setting, tutorRole: s.tutorRole, learnerRole: s.learnerRole, learnerGoal: s.learnerGoal,
      openingLine: opener, openingTranslation: '(tutor opens the scene)',
      constraints: [`Register: ${s.register}`, `Do not use English`].concat(s.mustDo),
      hints: s.mustDo, targetIds: t.map((x) => x.id ?? x.surface), maxTurns: 8,
    },
    extra: { scenarioId: s.id, register: s.register },
  };
}

export function buildQuizBeat(level: string, minutes: number, targets?: Target[]): Beat {
  const mode = Math.random() > 0.5 ? 'reading' : 'meaning';
  return {
    id: rid('b'), kind: 'quiz', minutes,
    titleJA: 'クイズ', titleEN: 'Quick check',
    objective: `Produce and recognise this week's items without prompting`,
    why: 'Retrieval under a little pressure shows what has actually stuck, as opposed to what merely looks familiar.',
    targets: targets?.slice(0, 3) ?? vocabOfLevel(level, 3),
    success: '4 of 5 correct, no hints',
    difficulty: 3,
    scaffolding: ['Think of the sentence you heard it in.', 'It appears in today’s reading too.', 'I’ll show the first mora.'],
    mode: 'text',
    quiz: quizFromVocab(level, Math.max(3, Math.round(minutes * 1.5)), mode as any),
  };
}

export function buildReadingBeat(level: string, minutes: number, targets?: Target[]): Beat {
  const p = READING_PASSAGES.find((x) => x.level === level) ?? READING_PASSAGES[0];
  return {
    id: rid('b'), kind: 'reading', minutes,
    titleJA: p.title, titleEN: p.titleEN,
    objective: `Read a short passage at 95%+ known vocabulary and answer questions without translating word-by-word`,
    why: 'Reading is where your vocabulary quietly doubles. The text is deliberately almost-entirely known so you read for meaning, not for the dictionary.',
    targets: targets?.slice(0, 2) ?? vocabOfLevel(level, 2),
    success: 'All comprehension questions answered from the text, not from guesswork',
    difficulty: 3,
    scaffolding: ['Read the question first — it tells you which sentence matters.', 'The answer is always in the text; you never need to infer.', 'Tap any word for a gloss.'],
    mode: 'text',
    reading: {
      title: p.title, text: p.text, glossary: p.glossary,
      questions: p.questions.map((q) => ({ id: rid('q'), prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, tags: ['reading'], level: p.level, targetIds: [] })),
      preTeach: [],
    },
  };
}

export function buildListeningBeat(level: string, minutes: number): Beat {
  const c = LISTENING_CLIPS.find((x) => x.level === level) ?? LISTENING_CLIPS[0];
  return {
    id: rid('b'), kind: 'listening', minutes,
    titleJA: c.title, titleEN: 'Listening lab',
    objective: 'Get the gist on first listen, then the detail on second',
    why: 'Real life gives you one hearing, not three. We train the gist pass first, then reward the detail pass.',
    targets: vocabOfLevel(level, 2),
    success: 'Gist question right on the first listen',
    difficulty: 4,
    scaffolding: ['Listen for the topic word only.', 'Second listen: numbers and times are where the answer hides.', 'Show the transcript.'],
    mode: 'voice',
    listening: {
      title: c.title, script: c.script, speed: 1,
      questions: c.questions.map((q) => ({ id: rid('q'), prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, tags: ['listening'], level: c.level, targetIds: [] })),
      transcriptRevealed: false,
    },
  };
}

export function buildGrammarBeat(level: string, minutes: number, focusTag?: string): Beat {
  const g = (focusTag ? GRAMMAR.filter((x) => x.errorTag === focusTag) : []).find(Boolean)
    ?? GRAMMAR.filter((x) => x.level === level)[0] ?? GRAMMAR[0];
  return {
    id: rid('b'), kind: 'grammar_focus', minutes,
    titleJA: `文法：${g.pattern}`, titleEN: `Noticing: ${g.pattern}`,
    objective: `Notice and produce ${g.pattern} (${g.en})`,
    why: `You have made this mistake a few times now. Instead of a rule, I will show you the pattern in four sentences and let you find it — that is what makes it stick.`,
    targets: [{ kind: 'grammar', id: g.id, surface: g.pattern, meaning: g.en, note: `Trap: ${g.commonError}` }],
    success: `You can produce two original sentences with ${g.pattern}`,
    difficulty: 3,
    scaffolding: ['Look at what comes directly before the pattern.', 'Where does the verb go?', `Model: ${g.example}`],
    mode: 'text',
    grammarPoint: {
      pattern: g.pattern,
      explanationEN: `${g.en}. The classic error: ${g.commonError}`,
      examples: [
        { ja: g.example, en: g.exampleEN },
        { ja: '（同型の例）' + g.example.replace(/。/g, '。'), en: 'same pattern, different content' },
      ],
      commonError: g.commonError,
      inputFlood: [g.example, g.example.replace(/私/g, '友だち'), g.example.replace(/昨日/g, '来週'), g.example.replace(/毎日/g, '来月')],
    },
  };
}

export function buildKanjiBeat(level: string, minutes: number): Beat {
  const ks = KANJI.filter((x) => x.level === level).slice(0, 3);
  const list = (ks.length ? ks : KANJI.slice(0, 3)).map((k) => ({
    char: k.char, meaning: k.meaning, onyomi: k.on, kunyomi: k.kun, words: k.words, mnemonic: k.mnemonic,
  }));
  return {
    id: rid('b'), kind: 'kanji_lab', minutes,
    titleJA: '漢字ラボ', titleEN: 'Kanji lab',
    objective: `Learn ${list.map((k) => k.char).join('・')} as components inside real words`,
    why: `Kanji learnt as pictures get forgotten. Learnt as parts of words you will actually use, they stay. Today: ${list.map((k) => k.char).join('、')}.`,
    targets: list.flatMap((k) => k.words.slice(0, 1).map((w) => ({ kind: 'kanji' as const, surface: w.ja, reading: w.reading, meaning: w.en, note: k.char }))),
    success: 'You can recognise each kanji inside its word, and write the hardest one from memory',
    difficulty: level === 'A1' ? 2 : 4,
    scaffolding: ['Count the radicals before you memorise strokes.', 'Say the reading out loud as you write.', 'Type it instead of writing it — production still counts.'],
    mode: 'text',
    kanji: list,
  };
}

export function buildShadowingBeat(level: string, minutes: number): Beat {
  const lines = [
    { ja: 'すみません、ちょっと 聞いても いいですか。', reading: 'すみません、ちょっと きいても いいですか。', en: 'Excuse me, may I ask you something?', focus: 'mora timing: keep 「ちょっと」 to one clean beat (cho-t-to)' },
    { ja: 'この 電車は 東京駅に 止まりますか。', reading: 'この でんしゃは とうきょうえきに とまりますか。', en: 'Does this train stop at Tokyo Station?', focus: 'pitch: でんしゃ rises then falls; do not stress one syllable like English' },
    { ja: 'おすすめは 何ですか。', reading: 'おすすめは なんですか。', en: 'What do you recommend?', focus: 'smooth phrasing — one breath, falling contour at the end' },
    { ja: 'もう 少し ゆっくり お願いします。', reading: 'もう すこし ゆっくり おねがいします。', en: 'A little slower, please.', focus: 'long vowels: もう and ゆっくり each hold their length' },
  ];
  return {
    id: rid('b'), kind: 'shadowing', minutes,
    titleJA: 'シャドーイング', titleEN: 'Shadowing',
    objective: 'Copy the rhythm, not the words: mora timing and phrase contour',
    why: 'Three minutes of shadowing does more for how you sound than an hour of grammar. Listen, then speak *with* the audio, not after it.',
    targets: [{ kind: 'sound', surface: 'mora timing', note: 'every mora = one beat' }, { kind: 'sound', surface: 'phrase-final fall', note: 'declaratives fall; questions rise' }],
    success: 'Your timing matches the model on at least three lines',
    difficulty: 3,
    scaffolding: ['Tap the syllables on the table as you speak.', 'Slow the audio to 0.85×.', 'Read the kana aloud before speaking it.'],
    mode: 'voice',
    lines,
  };
}

export function buildOpenEndedBeat(level: string, minutes: number): Beat {
  const prompts: Record<string, { ja: string; en: string }> = {
    'pre-A1': { ja: '私の一日について 三つ 書いてください。', en: 'Write three sentences about your day.' },
    A1: { ja: '週末に 何をしましたか。五つ 書いてください。', en: 'What did you do at the weekend? Write five sentences.' },
    'A2.1': { ja: '先週 いちばん 大変だった ことを 書いてください。どう しましたか。', en: 'Write about the most difficult thing last week. What did you do about it?' },
    A2: { ja: '日本で してみたい ことを 三つ、理由も 書いてください。', en: 'Three things you want to do in Japan, with reasons.' },
    B1: { ja: '日本語を 勉強して いちばん 変わった ことは 何ですか。具体的に 書いてください。', en: 'What has changed most for you since studying Japanese? Be specific.' },
    B2: { ja: 'リモートワークと 出社、どちらが 生産的だと 思いますか。両方の 意見を 書いた 上で、自分の 立場を 明確に してください。', en: 'Remote or office — which is more productive? Present both sides, then take a clear position.' },
  };
  const p = prompts[level] ?? prompts.A2;
  return {
    id: rid('b'), kind: 'open_ended', minutes,
    titleJA: '自由作文', titleEN: 'Free writing',
    objective: 'Sustain connected production for several sentences with a clear structure',
    why: 'Writing removes the escape hatch of a friendly listener. It is the honest measure of what you can assemble alone.',
    targets: vocabOfLevel(level, 3),
    success: 'Clear structure, one opinion, at least one subordinate clause',
    difficulty: 4,
    scaffolding: ['Plan three bullet points before writing.', 'Use 〜ので to link a reason.', 'Aim for plain nouns + one adjective per clause.'],
    mode: 'text',
    openEnded: {
      promptJA: p.ja, promptEN: p.en, minLength: Math.max(30, Math.round(minutes * 12)),
      hints: ['Start with 〜について', 'Use だから / ので for reasons', 'Finish with 〜と思います'],
      rubric: [
        { criterion: 'Task achievement', weight: 0.3, descriptor: 'All parts of the prompt answered.' },
        { criterion: 'Range', weight: 0.25, descriptor: 'Varied vocabulary and at least one subordinate clause.' },
        { criterion: 'Accuracy', weight: 0.25, descriptor: 'Particles and verb endings mostly correct; errors do not block meaning.' },
        { criterion: 'Cohesion', weight: 0.2, descriptor: 'Logical order with connectors (それから, でも, ので).' },
      ],
    },
  };
}

export function buildWarmupBeat(minutes: number, due: PlanRequest['dueCards'], fallbackLevel = 'A2.1'): Beat {
  const items: Target[] = due.slice(0, 6).map((c) => ({ kind: (c.kind as any) ?? 'vocab', id: c.id, surface: c.surface, reading: c.reading, meaning: c.meaning }));
  // Nothing due is the normal state on day one, and an empty beat is a dead end in a
  // live session: the learner has nothing to do and nothing to mark. Fall back to a
  // first pass over level-appropriate words, and say so honestly rather than pretending
  // it is spaced repetition.
  const first = !items.length;
  if (first) {
    const pool = VOCAB.filter((v) => v.level === fallbackLevel);
    const seed = pool.length ? pool : VOCAB;
    for (const v of seed.slice(0, Math.max(4, Math.round(minutes * 2)))) {
      items.push({ kind: 'vocab', id: v.id, surface: v.surface, reading: v.reading, meaning: v.en });
    }
  }
  return {
    id: rid('b'), kind: 'warmup', minutes,
    titleJA: 'ウォームアップ', titleEN: first ? 'Getting started' : 'Retrieval warm-up',
    objective: first
      ? 'Get the first words moving before anything harder'
      : 'Pull yesterday’s items out of memory before they fade further',
    why: first
      ? 'Nothing is due yet — we have not met long enough to have a queue — so this is a first pass at the words your level actually uses. From tomorrow, this slot fills with exactly what you were about to forget.'
      : 'These are the cards you were about to forget. Recalling them now is the cheapest learning in the whole session.',
    targets: items,
    success: 'Recall the reading and meaning without peeking',
    difficulty: 2,
    scaffolding: ['Say the reading out loud first.', 'Think of the sentence you first met it in.', 'Say “skip” and we will see it later today.'],
    mode: 'text',
    quiz: items.slice(0, 5).map((t) => {
      const src = VOCAB.find((v) => v.surface === t.surface);
      const others = src
        ? plausibleOthers(src, VOCAB).map((v) => v.en)
        : shuffle(VOCAB.filter((v) => v.surface !== t.surface).map((v) => v.en)).slice(0, 3);
      return { id: rid('q'), prompt: `「${t.surface}」 — meaning?`, options: shuffle([t.meaning ?? '—', ...others]), answer: t.meaning ?? '—', explanation: `${t.surface}${t.reading ? `（${t.reading}）` : ''} = ${t.meaning ?? ''}`, tags: ['srs'], level: 'A1' as any, targetIds: [t.id ?? t.surface] };
    }),
  };
}

export function buildRecapBeat(minutes: number, plan: Partial<SessionPlan>): Beat {
  return {
    id: rid('b'), kind: 'recap', minutes,
    titleJA: 'まとめ', titleEN: 'Debrief',
    objective: 'Consolidate: what worked, the two things to keep, and tomorrow’s hook',
    why: 'Sessions that end with an explicit "here is what changed" get remembered as progress. That feeling is what keeps you coming back in week six.',
    targets: [],
    success: 'You leave knowing the one thing you will do differently next time',
    difficulty: 1,
    scaffolding: ['Say which beat you found hardest.', 'Tell me if any of this felt too easy.'],
    mode: 'text',
  };
}

/** ------------------------------------------------------------------ plan */

export function mockPlan(req: PlanRequest): SessionPlan {
  const recipe = SESSION_RECIPES.find((r) => r.id === req.recipeId) ?? SESSION_RECIPES[0];
  const level = req.model.overall.cefr;
  const topTag = req.model.errorProfile.filter((e) => !e.resolved).sort((a, b) => b.count - a.count)[0]?.tag;

  const beats: Beat[] = recipe.shape.map((s) => {
    switch (s.kind) {
      case 'warmup': return buildWarmupBeat(s.minutes, req.dueCards, req.model?.overall?.cefr ?? 'A2.1');
      case 'grammar_focus': return buildGrammarBeat(level, s.minutes, topTag);
      case 'reading': return buildReadingBeat(level, s.minutes);
      case 'listening': return buildListeningBeat(level, s.minutes);
      case 'conversation':
      case 'roleplay': return buildConversationBeat(level, s.minutes, req.goalHint as any);
      case 'kanji_lab': return buildKanjiBeat(level, s.minutes);
      case 'shadowing': return buildShadowingBeat(level, s.minutes);
      case 'pronunciation': return buildShadowingBeat(level, s.minutes);
      case 'open_ended': return buildOpenEndedBeat(level, s.minutes);
      case 'quiz': return buildQuizBeat(level, s.minutes);
      case 'story': return buildReadingBeat(level, s.minutes);
      default: return buildRecapBeat(s.minutes, {});
    }
  });

  // scale the shape to the requested minutes, preserving proportions
  const planned = beats.reduce((a, b) => a + b.minutes, 0);
  const scale = req.minutes / planned;
  for (const b of beats) b.minutes = Math.max(1, Math.round(b.minutes * scale));

  const theme = beats.find((b) => b.kind === 'roleplay' || b.kind === 'conversation')?.titleEN
    ?? beats.find((b) => b.kind === 'grammar_focus')?.titleEN ?? 'Consolidation';
  const canDoPool = CANDO.filter((c) => cefrIndex(c.level) <= cefrIndex(level) + 1).slice(-2);

  return {
    id: rid('plan'),
    createdAt: Date.now(),
    titleJA: (beats.find((b) => b.kind === 'roleplay' || b.kind === 'conversation')?.titleJA) ?? beats[0]?.titleJA ?? 'レッスン',
    titleEN: theme,
    theme,
    rationale: `Scripted-plan mode (no model key). Even so, the shape is deliberate: recall first, then one focused thing, then you producing it in a situation you actually told me you need. ${topTag ? `Your ${errorTag(topTag).label} slips come up naturally in the middle block.` : ''}`,
    canDo: canDoPool.map((c) => c.statement),
    recipeId: recipe.id,
    mode: req.mode,
    totalMinutes: beats.reduce((a, b) => a + b.minutes, 0),
    beats,
    focusErrorTags: topTag ? [topTag] : [],
    reviewCardIds: req.dueCards.map((c) => c.id),
    nextSession: 'Next time we take the same items into a harder version of this scene — less scaffolding, faster replies.',
    designedBy: 'scripted tutor (no model key configured)',
  };
}

/** ------------------------------------------------------------------ conversation */

const PROGRESSION: Record<string, string[]> = {
  service: ['かしこまりました。ほかに ご注文は ございますか。', '少々 お待ちください。お会計は こちらで よろしいですか。', 'ありがとうございます。また お待ちして おります。'],
  travel: ['そうですか。では、三番線から 乗って、二つ目の 駅で 乗り換えてください。', '伝わりましたか。もう一度 ゆっくり 言いましょうか。', 'いいえ、けっこうですよ。お気をつけて。'],
  work: ['なるほど、状況は わかりました。いつまでに できそうですか。', 'その点は 私から も 確認して おきます。他に ありますか。', 'では、その方向で 進めましょう。ありがとうございます。'],
  social: ['いいね！で、それから どうしたの？', 'へえ、知らなかった。それ、難しくない？', 'いいね。今度 いっしょに 行こうよ。'],
};

export function mockTurn(beat: Beat, history: { role: 'tutor' | 'learner'; text: string }[], learnerText: string, level: string): { text: string; note?: string } {
  const tags = (beat.extra?.scenarioId ? SCENARIOS.find((s) => s.id === beat.extra!.scenarioId)?.tags : undefined) ?? [];
  const bucket = tags.includes('work') || tags.includes('business') ? 'work'
    : tags.includes('social') ? 'social'
    : tags.includes('travel') ? 'travel' : 'service';
  const learnerTurns = history.filter((h) => h.role === 'learner').length;
  const lines = PROGRESSION[bucket];
  const base = lines[Math.min(learnerTurns, lines.length - 1)];

  const issues = detectIssues(learnerText, level);
  const praised = history.filter((h) => h.role === 'learner').length === 0 && learnerText.trim().length > 8;
  const ack = praised ? ['はい、わかりました。', 'なるほど、そうですか。', 'そうなんですね。'][Math.floor(Math.random() * 3)] : '';
  const recast = issues[0] ? `（そうそう、たとえば「${issues[0].recast}」のように 言えますね。）` : '';
  const ask = learnerTurns >= 2 ? 'では、次は どのように されますか？' : 'どう 思いますか？';

  const text = [ack, issues[0]?.elicit ?? '', recast, base, learnerTurns >= 3 ? ask : ''].filter(Boolean).join(' ');
  return { text, note: issues[0] ? `${errorTag(issues[0].tag).label} appears again — targeting next session.` : undefined };
}

/** ------------------------------------------------------------------ marking */

export function mockFeedback(args: {
  beat: Beat; transcript: { role: 'tutor' | 'learner'; text: string }[];
  answers?: { prompt: string; expected: string; given: string; correct: boolean }[]; level: string;
}): Feedback {
  const learnerTexts = args.transcript.filter((t) => t.role === 'learner').map((t) => t.text);
  const joined = learnerTexts.join('\n');
  const notices: Notice[] = [];
  for (const t of learnerTexts) notices.push(...detectIssues(t, args.level));
  const unique: Notice[] = [];
  const seen = new Set<string>();
  for (const n of notices) { if (!seen.has(n.tag)) { seen.add(n.tag); unique.push(n); } }

  const correct = args.answers?.filter((a) => a.correct).length ?? 0;
  const total = args.answers?.length ?? 0;
  // Wrong answers on generated items are evidence too — surface the trap behind them.
  for (const a of (args.answers ?? []).filter((x) => !x.correct).slice(0, 2)) {
    if (unique.some((n) => n.tag === 'vocab.collocation')) continue;
    unique.push({
      quote: a.given, tag: 'vocab.collocation',
      issue: `You answered "${a.given}" where "${a.expected}" was wanted.`,
      recast: a.expected,
      elicit: 'もう 一度、考えて みましょうか？ どこで 見た ことばですか？',
      severity: 1,
    });
  }
  const acc = total ? correct / total : null;
  const wins: string[] = [];
  if (acc !== null && acc >= 0.8) wins.push(`${correct}/${total} correct — that is solid recall, not luck.`);
  if (learnerTexts.length) wins.push(`You kept going for ${learnerTexts.length} turn${learnerTexts.length === 1 ? '' : 's'} — the length of your answers is itself progress.`);
  const targetUse = args.beat.targets.filter((t) => joined.includes(t.surface));
  if (targetUse.length) wins.push(`You used 「${targetUse.map((t) => t.surface).join('」「')}」 in your own production. That is the item moving from recognition into use.`);
  if (!wins.length) wins.push('You showed up and produced output, which is the part most people skip.');

  const codeSwitch = learnerTexts.length ? learnerTexts.reduce((a, t) => a + countCodeSwitch(t), 0) / learnerTexts.length : 0;
  const meanLen = learnerTexts.length ? learnerTexts.reduce((a, t) => a + t.length, 0) / learnerTexts.length : 0;

  return {
    achieved: (() => {
      const obj = String(args.beat.objective ?? '').replace(/[.。]\s*$/, '');
      if (acc !== null) {
        return `Objective: ${obj} — ${acc >= 0.75 ? 'met' : acc >= 0.5 ? 'partly met' : 'not met yet, and that is useful information for me'}.`;
      }
      // Beats with nothing measurable (recap, story, free talk) should not be told they
      // produced zero of anything.
      if (!learnerTexts.length && !total) return `Nothing to mark here, by design — this one is for consolidating, not scoring.`;
      if (!learnerTexts.length) return `You worked through ${total} item${total === 1 ? '' : 's'} here, with no spoken or written answers to judge.`;
      return `${learnerTexts.length} turn${learnerTexts.length === 1 ? '' : 's'} towards “${obj}”.`;
    })(),
    band: args.level as any,
    wins,
    notices: unique.slice(0, 3),
    targets: args.beat.targets.slice(0, 3).map((t) => ({ ...t, note: t.note ?? 'keep it — it came up in your own output' })),
    nextTime: unique.length
      ? `Next session we will run the same scene again, but I will push you to use 「${unique[0].recast.slice(0, 24)}」 without thinking about it.`
      : 'Next session I will raise the speed and add a complication to the scene.',
    errorTags: unique.map((n) => n.tag),
    modelPatch: {
      metrics: {
        meanUtteranceLength: Math.round(meanLen),
        codeSwitchRate: Math.round(codeSwitch * 100) / 100,
        selfRepairRate: 0,
        listeningAccuracyAtNativeSpeed: acc ?? 0.5,
        readingWPM: 0,
        fluencyScore: Math.min(100, Math.round(meanLen * 1.6 + learnerTexts.length * 4)),
      },
    } as any,
  };
}

export function mockDebrief(plan: SessionPlan, transcript: { role: string; text: string }[], level: string) {
  const learner = transcript.filter((t) => t.role === 'learner').map((t) => t.text);
  const notices: Notice[] = [];
  for (const t of learner) notices.push(...detectIssues(t, level));
  const seen = new Set<string>();
  const toKeep = notices.filter((n) => (seen.has(n.tag) ? false : (seen.add(n.tag), true))).slice(0, 3);
  const cards = plan.beats.flatMap((b) => b.targets).slice(0, 4).map((t) => ({ surface: t.surface, reading: t.reading ?? '', meaning: t.meaning ?? '' }));
  return {
    headline: learner.length
      ? `Good session — ${learner.length} turn${learner.length === 1 ? '' : 's'} of your own language, and ${cards.length} item${cards.length === 1 ? '' : 's'} worth keeping.`
      : 'Quiet one — let’s get you talking more next time.',
    highlights: learner.slice(-2).map((l) => `「${l.slice(0, 40)}${l.length > 40 ? '…' : ''}」 — natural and clear.`),
    toKeep,
    newCards: cards,
    canDoAdvanced: plan.canDo[0] ?? '',
    nextTeaser: plan.nextSession ?? 'Next time we go one notch harder on the same ground.',
    notebook: `Scripted debrief. ${toKeep.length} recurring patterns logged: ${toKeep.map((t) => t.tag).join(', ') || 'none'}.`,
  };
}

export function mockPlacement(profile: Profile, evidence: any): LearnerModel {
  const acc: number = evidence.quizAccuracy ?? 0.5;
  const kana: number = evidence.kanaScore ?? 0;
  const speaking: number = evidence.speakingScore ?? acc;
  const writing: number = evidence.writingScore ?? acc;
  const interview: number = evidence.interviewScore ?? speaking;
  const readingWPM: number = evidence.readingWPM ?? 0;
  const listening: number = evidence.listeningScore ?? acc;

  const base = Math.max(0, Math.min(6, Math.round(acc * 5) + (profile.background.inJapanMonths > 3 ? 1 : 0)));
  const mk = (idx: number, confidence: number, n: number) => ({ cefr: cefrAt(idx), percentile: 45 + Math.round(acc * 40), confidence, evidenceCount: n, lastUpdated: Date.now() });
  const lvl = (i: number) => cefrAt(Math.max(0, Math.min(9, i)));

  const skills = {
    listening: mk(Math.round(base * 0.9), 0.45, 6),
    speaking: mk(Math.round(base * 0.85), 0.6, 5),
    reading: mk(base + (kana > 0.7 ? 1 : 0), 0.5, 8),
    writing: mk(Math.max(0, base - 1), 0.4, 3),
    vocabulary: mk(base, 0.55, 12),
    grammar: mk(base, 0.5, 10),
    kanji: mk(Math.max(0, base - 1 + (kana > 0.8 ? 1 : 0)), 0.45, 8),
    interaction: mk(Math.round(base * 0.9), 0.5, 4),
  };
  const overallIdx = Math.round(Object.values(skills).reduce((a, s) => a + cefrIndex(s.cefr), 0) / 8);

  return {
    skills,
    overall: { cefr: cefrAt(overallIdx), confidence: 0.5, jlptEstimate: overallIdx <= 1 ? 'none' : overallIdx <= 3 ? 'N5' : overallIdx <= 4 ? 'N4' : overallIdx <= 6 ? 'N3' : overallIdx <= 8 ? 'N2' : 'N1' },
    vocabSizeEstimate: Math.round(Math.pow(2.1, overallIdx + 4)),
    kanjiKnown: [20, 110, 200, 280, 350, 550, 750, 1000, 1400, 2000][Math.max(0, Math.min(9, overallIdx))],
    kanjiLearning: 12,
    scripts: { hiragana: kana, katakana: Math.min(1, kana * 0.85), kanji: Math.min(1, overallIdx / 9), 'romaji-free': profile.style.romaji === 'never' ? 0.8 : 0.3 },
    metrics: {
      readingWPM: readingWPM || Math.round(20 + overallIdx * 12),
      listeningAccuracyAtNativeSpeed: listening,
      meanUtteranceLength: Math.round(speaking * 40),
      selfRepairRate: 0.1, codeSwitchRate: Math.max(0, 0.5 - overallIdx * 0.06),
      fluencyScore: Math.round(speaking * 100),
    },
    errorProfile: [],
    interactionProfile: { aizuchiUse: Math.round(interview * 100), questionForming: Math.round(interview * 80), turnTaking: Math.round(interview * 90), negotiation: Math.round(speaking * 70) },
    streaks: { current: 0, longest: 0, totalSessions: 0, totalMinutes: 0 },
    notes: [
      'Scripted placement (no model key). Numbers are heuristic: they come from raw accuracy, not judgement.',
      'Re-run placement with a model key for a real evidence-backed estimate.',
    ],
  };
}

export function mockGloss(term: string, level: string) {
  const v = VOCAB.find((x) => x.surface.includes(term) || term.includes(x.surface.replace(/[〜~]/g, '')));
  if (v) return { reading: v.reading, meaningEN: v.en, pos: v.pos, note: `Seen in: ${v.example}`, example: v.example, exampleEN: v.exampleEN };
  const k = KANJI.find((x) => x.char === term || x.words.some((w) => w.ja.includes(term)));
  if (k) {
    const w = k.words.find((x) => x.ja.includes(term)) ?? k.words[0];
    return { reading: w.reading, meaningEN: w.en, pos: 'kanji word', note: `${k.char} = ${k.meaning}. ${k.mnemonic}`, example: w.ja, exampleEN: w.en };
  }
  return { reading: '', meaningEN: '(not in the seed dictionary — a model key would gloss this)', pos: 'unknown', note: 'Add GEMINI_API_KEY for live glossing of any word.', example: '', exampleEN: '' };
}

export function mockStory(episode: number, level: string, dueItems: string[]) {
  const eps = [
    { text: '駅の 前で、みどりは 友だちを 待って いました。五分、十分、二十分。電車は 来たのに、友だちは 来ません。みどりは スマホを 見て、小さく 言いました。「まさか…」', en: 'In front of the station, Midori was waiting for her friend. Five, ten, twenty minutes. The train came, but her friend did not. She looked at her phone and said quietly: "Don\'t tell me…"' },
    { text: '次の 日、みどりは 同じ 場所に 立ちました。今度は 早く 来ました。「昨日は ごめん」と 友だちが 言いました。「電車が 止まって…」みどりは 少し 笑って、「いいよ。でも、今日は おごってね」と 言いました。', en: 'The next day Midori stood in the same place. This time she arrived early. "Sorry about yesterday," her friend said. "The train stopped…" Midori smiled a little. "It\'s fine. But today you\'re paying."' },
  ];
  const e = eps[Math.min(episode - 1, eps.length - 1)];
  return {
    titleJA: `第${episode}話 駅の前で`, titleEN: `Episode ${episode}: In front of the station`,
    text: e.text, hook: 'Who was actually waiting for whom?',
    glossary: [
      { surface: 'まさか', reading: 'まさか', meaning: 'surely not / don\'t tell me' },
      { surface: 'おごる', reading: 'おごる', meaning: 'to treat someone (pay for them)' },
    ],
    question: { prompt: 'みどりは どんな 気持ちでしたか。', options: ['うれしい', '少し おこっている', 'とても 眠い', 'わからない'], answer: '少し おこっている', explanation: '待たされて、次の日は「おごってね」と 言っています。' },
    level,
    dueItems,
  };
}

export function mockRegister(content: string, registers: string[]) {
  return {
    items: registers.map((r) => ({
      register: r,
      ja: r === 'casual' ? content.replace(/です|ます/g, '') + 'よ' : r === 'keigo' ? `お手数ですが、${content}` : content,
      reading: '',
      en: '',
      note: r === 'keigo'
        ? 'Humble frame added for your own action; the content itself does not change — only who is raised and who is lowered.'
        : 'Register lives in the frame, not the content word.',
    })),
  };
}

export function mockTranslation(source: string, direction: 'ja-en' | 'en-ja') {
  return { reference: '', natural: '', literal: '', trap: 'Model key required for real translation marking.', direction, source };
}

export function mockGradeOpen(text: string, beat: Beat, level: string): Feedback {
  const len = text.length;
  const min = beat.openEnded?.minLength ?? 30;
  const notices = detectIssues(text, level);
  const hits: string[] = [];
  for (const r of beat.openEnded?.rubric ?? []) {
    if (r.criterion === 'Range' && /(ので|から|が|けど|し|ながら|たら)/.test(text)) hits.push('Range: you linked clauses with a connector — that is what pushes a text from A2 into B1.');
    if (r.criterion === 'Cohesion' && /(それから|でも|だから|そして|しかし|まず)/.test(text)) hits.push('Cohesion: clear signposting between ideas.');
  }
  return {
    achieved: len >= min ? 'Length target met.' : `A bit short of the ${min}-character target — that is a fluency limit, not an accuracy one.`,
    band: level as any,
    wins: hits.length ? hits : ['You committed to writing something — that is the part people avoid.'],
    notices: notices.slice(0, 3),
    targets: [],
    nextTime: 'Next time I will give you the same prompt with a 60-second timer, to push the automaticity.',
    errorTags: notices.map((n) => n.tag),
  };
}

/**
 * pedagogy.ts — the research-backed rules the tutor is not allowed to break.
 *
 * Encoded from the SLA literature we designed against:
 *  · Comprehensible input: 95–98% of tokens should be known (Nation 2006; Laufer 1989;
 *    Schmitt et al. 2011). Below ~90% comprehension collapses and acquisition stalls.
 *  · i+1: exactly one step beyond current ability (Krashen; cf. Vygotsky's ZPD).
 *  · Chunks & high-frequency language before rules.
 *  · Retrieval practice + spacing beat re-reading (Roediger & Karpicke; FSRS-style scheduling).
 *  · Interleaving > blocked practice for transfer.
 *  · Noticing: input flood + input enhancement, then guided discovery, *then* explanation.
 *  · TBLT: tasks with interactional authenticity, not exercises.
 *  · Corrective feedback: dialogic (elicit → self-repair) beats monologic dumps;
 *    timing is a learner preference, not a dogma.
 *  · Visual + narrative pronunciation feedback > visual alone (Hirschi 2025).
 *  · Low affective filter: anxiety and boredom block uptake.
 */

import type { CEFR, JLPT, LearnerModel, Skill, Target, TaskKind } from '../types';

export const CEFR_ORDER: CEFR[] = ['pre-A1', 'A1', 'A1+', 'A2.1', 'A2', 'A2+', 'B1', 'B1+', 'B2', 'C1'];

export function cefrIndex(c: CEFR): number {
  return Math.max(0, CEFR_ORDER.indexOf(c));
}

export function cefrAt(i: number): CEFR {
  return CEFR_ORDER[Math.max(0, Math.min(CEFR_ORDER.length - 1, i))];
}

export function stepCefr(c: CEFR, delta: number): CEFR {
  return cefrAt(cefrIndex(c) + delta);
}

/** JLPT ↔ CEFR reference levels, as printed on JLPT score reports from Dec 2025. */
export function cefrToJLPT(c: CEFR): JLPT {
  const i = cefrIndex(c);
  if (i <= 1) return 'none';
  if (i <= 3) return 'N5';
  if (i <= 4) return 'N4';
  if (i <= 6) return 'N3';
  if (i <= 8) return 'N2';
  return 'N1';
}

/** Coarse target vocabulary size per CEFR band for Japanese (order-of-magnitude, for framing). */
export const VOCAB_BY_CEFR: Record<CEFR, number> = {
  'pre-A1': 120, A1: 800, 'A1+': 1300, 'A2.1': 1800, A2: 2500, 'A2+': 3500,
  B1: 5500, 'B1+': 8000, B2: 11000, C1: 15000,
};

/** Approximate kanji counts commonly quoted alongside each band (kanken/JLPT-aligned). */
export const KANJI_BY_CEFR: Record<CEFR, number> = {
  'pre-A1': 20, A1: 110, 'A1+': 200, 'A2.1': 280, A2: 350, 'A2+': 550,
  B1: 750, 'B1+': 1000, B2: 1400, C1: 2000,
};

/** How much of the input the learner should already know (fraction). CI window. */
export function knownTokenTarget(_level: CEFR): { min: number; max: number } {
  return { min: 0.95, max: 0.98 };
}

/**
 * Lightweight token difficulty proxy for Japanese: a token is "hard" if it is
 * kanji the learner doesn't know, a word outside their deck, or longer than
 * 4 morae with no entry. Used to gate generated passages before they reach
 * the learner — the app refuses to show text that is too dense.
 */
export function estimateCoverage(
  text: string,
  known: (t: string) => boolean,
): { coverage: number; unknowns: string[]; tokens: number } {
  const tokens = text
    .replace(/[。、！？「」…\s]/g, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean);
  const unknowns: string[] = [];
  for (const t of tokens) if (!known(t)) unknowns.push(t);
  const uniq = [...new Set(unknowns)];
  return { coverage: tokens.length ? 1 - uniq.length / Math.max(tokens.length, uniq.length) : 1, unknowns: uniq, tokens: tokens.length };
}

// ---------------------------------------------------------------- error taxonomy

/**
 * Japanese-specific error taxonomy. Every correction the tutor makes is tagged with
 * one of these, which is what makes the learner model *actionable*: we don't just
 * know they're "B1", we know they chronically drop を and overuse は where が belongs.
 */
export const ERROR_TAXONOMY: Record<string, { label: string; domain: string; coach: string }> = {
  'particle.wa_ga': { label: 'は vs が topic/subject', domain: 'particles', coach: 'Contrast a known topic (は) with new information (が).' },
  'particle.ni_de': { label: 'に vs で location/purpose', domain: 'particles', coach: 'に = destination/existence, で = where an action happens.' },
  'particle.wo_drop': { label: 'Dropped or wrong object particle', domain: 'particles', coach: 'Transitive verbs want を (or nothing at all in casual speech).' },
  'particle.mo_only': { label: 'も / だけ / しか confusion', domain: 'particles', coach: 'しか requires a negative predicate.' },
  'verb.te_form': { label: 'て-form formation', domain: 'verbs', coach: 'Sound-change groups: う/つ/る→って, む/ぶ/ぬ→んで, く→いて.' },
  'verb.politeness': { label: 'Register mismatch (casual ⇄ ます)', domain: 'register', coach: 'Keep one register for a whole turn; switch deliberately.' },
  'verb.transitivity': { label: 'Transitive/intransitive pairs', domain: 'verbs', coach: '開く/開ける, 始まる/始める — who causes the change?' },
  'verb.aspect.teiru': { label: 'ている (progressive vs resultative)', domain: 'aspect', coach: '知っている = state, 食べている = in progress.' },
  'tense.past': { label: 'Tense', domain: 'tense', coach: '〜ました vs 〜ます; time words usually do the heavy lifting.' },
  'adj.i_na': { label: 'い-adjective vs な-adjective', domain: 'adjectives', coach: 'い-adj inflect themselves; な-adj need だ/です.' },
  'counter.classifier': { label: 'Counter mismatch', domain: 'numeracy', coach: '人/つ/枚/本/匹 — pick by shape and kind.' },
  'keigo.honorific': { label: '尊敬語 (respectful)', domain: 'keigo', coach: 'For the other person: いらっしゃる, おっしゃる, ご覧になる.' },
  'keigo.humble': { label: '謙譲語 (humble)', domain: 'keigo', coach: 'For yourself: 参る, 申す, いただく, 伺う.' },
  'keigo.uchi_soto': { label: 'In-group/out-group logic', domain: 'keigo', coach: "Never use 尊敬語 about your own team, even if they're senior." },
  'wordorder': { label: 'Word order / clause linking', domain: 'syntax', coach: 'Verb last; modifiers immediately before what they modify.' },
  'topic.dropped': { label: 'Topic dropped when it was needed', domain: 'discourse', coach: 'Drop topics only when recoverable from context.' },
  'nominalizer.no_koto': { label: 'の vs こと nominalising', domain: 'syntax', coach: 'の after perception verbs (見える/聞こえる), こと after abstract ones.' },
  'conditional.forms': { label: 'と / ば / たら / なら', domain: 'conditionals', coach: 'たら = sequence/factuality; なら = given the topic; と = automatic.' },
  'passive.causative': { label: '受身 / 使役', domain: 'voice', coach: 'Passive for adversity, causative for "make/let".' },
  'pron.pitch': { label: 'Pitch accent', domain: 'pronunciation', coach: 'Pitch is lexical in Japanese: 箸[1] vs 橋[2] vs 端[0].' },
  'pron.mora': { label: 'Mora timing (long vowels / っ / ん)', domain: 'pronunciation', coach: 'Each mora gets one beat: おばさん vs おばあさん.' },
  'pron.devoicing': { label: 'Vowel devoicing', domain: 'pronunciation', coach: 'すき sounds like [ski] — that is correct, not lazy.' },
  'pron.intonation': { label: 'Sentence intonation / phrasing', domain: 'pronunciation', coach: 'Drop pitch across the phrase; don\'t stress one word like English.' },
  'kana.confusion': { label: 'Kana confusion (し/つ, ソ/ン)', domain: 'script', coach: 'Drill the mirrored pairs with minimal-pair words.' },
  'kanji.reading': { label: 'On-yomi vs kun-yomi choice', domain: 'kanji', coach: 'Compounds usually take on-yomi; single kanji + okurigana take kun-yomi.' },
  'kanji.rtk': { label: 'Kanji production (write/recognise)', domain: 'kanji', coach: 'Study by radical + a story, then test production, not recognition.' },
  'vocab.false_friend': { label: 'Wasei-eigo / false friend', domain: 'vocabulary', coach: 'マンション = apartment block, not mansion.' },
  'vocab.collocation': { label: 'Unnatural collocation', domain: 'vocabulary', coach: 'Learn words inside chunks: 電話をかける, not 電話をする.' },
  'l1.codeswitch': { label: 'Code-switching to L1', domain: 'strategy', coach: 'Use 〜って何ですか / もう一度お願いします instead of dropping to English.' },
  'interaction.aizuchi': { label: 'Missing 相槌 (aizuchi)', domain: 'interaction', coach: 'Nod with うん / なるほど / そうなんですね while listening.' },
  'interaction.repair': { label: 'No repair strategy when stuck', domain: 'interaction', coach: 'Ask for repetition/clarification rather than going silent.' },
};

export function errorTag(tag: string) {
  return ERROR_TAXONOMY[tag] ?? { label: tag, domain: 'other', coach: '' };
}

// ---------------------------------------------------------------- SRS (FSRS-lite)

export interface CardState {
  id: string;
  kind: 'vocab' | 'grammar' | 'kanji' | 'sound';
  surface: string;
  reading?: string;
  meaning?: string;
  tags: string[];
  level: string;
  stability: number;   // days
  difficulty: number;  // 1..10
  reps: number;
  lapses: number;
  due: number;         // epoch ms
  lastReview: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
}

const DAY = 86_400_000;

/** Retrievability curve used by FSRS. */
export function retrievability(card: CardState, now = Date.now()): number {
  const t = Math.max(0.01, (now - card.lastReview) / DAY);
  return Math.pow(1 + t / (9 * Math.max(0.1, card.stability)), -1);
}

/**
 * FSRS-inspired update. Grades: 1 again, 2 hard, 3 good, 4 easy.
 * Target retention 0.9 by default — the sweet spot for vocabulary (Anki's own
 * modelling shows 0.85–0.92 costs little and saves a lot of review time).
 */
export function reviewCard(card: CardState, grade: 1 | 2 | 3 | 4, now = Date.now(), targetRetention = 0.9): CardState {
  const next: CardState = { ...card, reps: card.reps + 1, lastReview: now };
  if (grade === 1) {
    next.lapses += 1;
    next.stability = Math.max(0.4, card.stability * 0.4);
    next.difficulty = Math.min(10, card.difficulty + 0.8);
    next.state = card.state === 'new' ? 'learning' : 'relearning';
    next.due = now + 10 * 60_000;
    return next;
  }
  const d = Math.max(1, Math.min(10, card.difficulty + (grade === 2 ? 0.4 : grade === 4 ? -0.6 : 0)));
  const factor = grade === 2 ? 1.2 : grade === 4 ? 3.2 : 2.4;
  const firstInterval = grade === 2 ? 1 : grade === 4 ? 4 : 2;
  const stability = card.state === 'new' ? firstInterval : Math.max(1, card.stability * factor * (1 - (d - 5) / 40));
  next.difficulty = d;
  next.stability = stability;
  next.state = 'review';
  const interval = Math.max(1, Math.round((stability * (Math.log(targetRetention) / Math.log(0.9))) / (1 + 0)) );
  next.due = now + interval * DAY;
  return next;
}

export function newCard(t: Target, level: string): CardState {
  const id = t.id ?? `${t.kind}:${t.surface}`;
  return {
    id, kind: t.kind === 'sound' ? 'sound' : (t.kind as CardState['kind']),
    surface: t.surface, reading: t.reading, meaning: t.meaning,
    tags: [], level, stability: 0, difficulty: 5, reps: 0, lapses: 0,
    due: Date.now(), lastReview: 0, state: 'new',
  };
}

// ---------------------------------------------------------------- placement

/** Convert placement evidence into an honest estimate range. We never claim
 *  precision we don't have: low evidence = wide band + low confidence. */
export function bandFromAccuracy(acc: number, startLevel: CEFR, mastered: number): { cefr: CEFR; percentile: number } {
  // acc: 0..1 accuracy on items branching around startLevel
  let delta = 0;
  if (acc >= 0.9) delta = 2;
  else if (acc >= 0.75) delta = 1;
  else if (acc >= 0.55) delta = 0;
  else if (acc >= 0.35) delta = -1;
  else delta = -2;
  const base = cefrIndex(startLevel) + delta;
  return { cefr: cefrAt(base), percentile: Math.round(40 + Math.max(0, Math.min(1, acc)) * 55) };
}

export function overallFromSkills(skills: Record<Skill, { cefr: CEFR }>): { cefr: CEFR; index: number } {
  const weights: Record<Skill, number> = {
    listening: 1, speaking: 1, reading: 1, writing: 1, vocabulary: 0.8, grammar: 0.8, kanji: 0.7, interaction: 0.6,
  };
  let sum = 0, wsum = 0;
  for (const [k, v] of Object.entries(skills) as [Skill, { cefr: CEFR }][]) {
    sum += cefrIndex(v.cefr) * weights[k];
    wsum += weights[k];
  }
  return { cefr: cefrAt(Math.round(sum / wsum)), index: Math.round(sum / wsum) };
}

/** Session shapes — how real tutors spend the minutes. Planner picks one and adapts. */
export interface Recipe {
  id: string;
  when: string;
  shape: { kind: TaskKind; minutes: number; note: string }[];
}

export const SESSION_RECIPES: Recipe[] = [
  {
    id: 'balanced_20',
    when: 'default 20-minute session',
    shape: [
      { kind: 'warmup', minutes: 2, note: 'retrieval warm-up on due cards' },
      { kind: 'grammar_focus', minutes: 4, note: 'noticing: flood → discovery → explanation' },
      { kind: 'reading', minutes: 5, note: 'i+1 passage at 95–98% coverage' },
      { kind: 'conversation', minutes: 6, note: 'production task reusing today\'s items' },
      { kind: 'recap', minutes: 3, note: 'debrief, corrections, can-do update' },
    ],
  },
  {
    id: 'speaking_forward_20',
    when: 'speaking-weak learner, goal = travel/work, or voice preference',
    shape: [
      { kind: 'shadowing', minutes: 2, note: 'warm the mouth, mora timing' },
      { kind: 'roleplay', minutes: 9, note: 'task with a real-world goal + constraints' },
      { kind: 'pronunciation', minutes: 4, note: 'target the top recurring sound error' },
      { kind: 'recap', minutes: 5, note: 'replay + dialogic feedback' },
    ],
  },
  {
    id: 'input_heavy_20',
    when: 'recovering from a hard session, low energy, or reading/listening focus',
    shape: [
      { kind: 'listening', minutes: 6, note: 'gist → detail → reading-while-listening' },
      { kind: 'story', minutes: 8, note: 'extensive-ish reading at high coverage' },
      { kind: 'quiz', minutes: 3, note: 'low-stakes comprehension check' },
      { kind: 'recap' as const, minutes: 3, note: 'debrief' },
    ],
  },
  {
    id: 'exam_sprint_30',
    when: 'JLPT deadline inside 12 weeks',
    shape: [
      { kind: 'warmup', minutes: 3, note: 'timed recall' },
      { kind: 'quiz', minutes: 10, note: 'exam-style section under time pressure' },
      { kind: 'reading', minutes: 7, note: 'timed passage, then review the traps' },
      { kind: 'listening', minutes: 6, note: 'native speed, no pausing' },
      { kind: 'recap', minutes: 4, note: 'error-pattern debrief + strategy notes' },
    ],
  },
  {
    id: 'micro_5',
    when: 'learner pressed "5 minutes" or is on a commute',
    shape: [
      { kind: 'warmup', minutes: 2, note: 'SRS only' },
      { kind: 'conversation', minutes: 3, note: 'one tiny exchange, one correction' },
    ],
  },
  {
    id: 'kanji_20',
    when: 'kanji debt is the bottleneck for their goal',
    shape: [
      { kind: 'warmup' as const, minutes: 2, note: 'radical recall' },
      { kind: 'kanji_lab', minutes: 10, note: 'radical + mnemonic + contextual words' },
      { kind: 'reading', minutes: 5, note: 'read a passage containing exactly those kanji' },
      { kind: 'recap' as const, minutes: 3, note: 'debrief' },
    ],
  },
];

export function skillRank(s: { cefr: CEFR }) {
  return cefrIndex(s.cefr);
}

/**
 * Recipe selection, in the order a real tutor would decide:
 * time available → exam pressure → the skill that is holding them back.
 */
export function pickRecipe(
  m: LearnerModel,
  minutes: number,
  goalHint?: 'kanji' | 'speaking' | 'input' | 'exam' | undefined,
  jlptDeadlineDays?: number,
) {
  if (minutes <= 8) return SESSION_RECIPES.find((r) => r.id === 'micro_5')!;
  if (goalHint === 'kanji') return SESSION_RECIPES.find((r) => r.id === 'kanji_20')!;
  if (jlptDeadlineDays !== undefined && jlptDeadlineDays < 84) return SESSION_RECIPES.find((r) => r.id === 'exam_sprint_30')!;
  if (goalHint === 'input') return SESSION_RECIPES.find((r) => r.id === 'input_heavy_20')!;
  const speakingGap = skillRank(m.skills.speaking) - skillRank(m.skills.reading);
  if (goalHint === 'speaking' || speakingGap <= -1) return SESSION_RECIPES.find((r) => r.id === 'speaking_forward_20')!;
  return SESSION_RECIPES.find((r) => r.id === 'balanced_20')!;
}

/** Target-language ratio the tutor should aim for, by level. Beginners drown without L1 scaffolding. */
export function targetLanguageRatio(level: CEFR, style: string): number {
  const i = cefrIndex(level);
  let base = i <= 1 ? 0.45 : i <= 3 ? 0.65 : i <= 5 ? 0.8 : i <= 7 ? 0.92 : 0.98;
  if (style === 'none') base += 0.08;
  if (style === 'lots') base -= 0.2;
  return Math.max(0.2, Math.min(0.99, base));
}

/** Pitch-accent minimal pairs (Tokyo standard) — used by the pronunciation tool.
 *  In production this table should come from a licensed accent dictionary (OJAD/NHK). */
export const PITCH_PAIRS = [
  { a: { ja: '箸', reading: 'はし', accent: 1, en: 'chopsticks' }, b: { ja: '橋', reading: 'はし', accent: 2, en: 'bridge' }, c: { ja: '端', reading: 'はし', accent: 0, en: 'edge' } },
  { a: { ja: '雨', reading: 'あめ', accent: 1, en: 'rain' }, b: { ja: '飴', reading: 'あめ', accent: 0, en: 'candy' } },
  { a: { ja: '神', reading: 'かみ', accent: 1, en: 'god' }, b: { ja: '紙', reading: 'かみ', accent: 2, en: 'paper' } },
  { a: { ja: '日本', reading: 'にほん', accent: 2, en: 'Japan' }, b: { ja: '二本', reading: 'にほん', accent: 1, en: 'two (long things)' } },
];

/**
 * tasks.ts — THE TOOL KIT.
 *
 * The design contract of the product: **the AI designs the session, the app provides
 * the tools.** Every task type below is a tool the planner can drop into a session.
 * A tool declares:
 *   · what it is for (why it exists pedagogically)
 *   · what the model must generate for it (the `generates` contract)
 *   · what the UI emits back (the `events` contract)
 *   · how it is marked (deterministic check vs rubric vs conversational)
 *   · which modalities it needs
 *
 * Adding a new activity to the tutor's vocabulary = adding one entry here plus one
 * renderer in public/tools.js. Nothing else in the system changes.
 */

import type { Mode, TaskKind } from '../types';

export interface ToolSpec {
  kind: TaskKind;
  nameEN: string;
  nameJA: string;
  icon: string;                    // inline SVG path id (see public/tools.js)
  modes: Mode[];
  /** Minute range this tool is worth using for. */
  minutes: [number, number];
  /** What the planner must supply. Validated before the session is shown. */
  generates: string[];
  /** Events the renderer emits back to the learner model. */
  events: string[];
  marking: 'deterministic' | 'rubric' | 'conversational' | 'none';
  /** Pedagogical justification, quoted in the UI's "why this?" popover. */
  pedagogy: string;
  /** Which skills this tool produces evidence for. */
  evidence: ('listening' | 'speaking' | 'reading' | 'writing' | 'vocabulary' | 'grammar' | 'kanji' | 'interaction')[];
}

export const TOOLS: ToolSpec[] = [
  {
    kind: 'warmup', nameEN: 'Retrieval warm-up', nameJA: 'ウォームアップ', icon: 'bolt', modes: ['text', 'voice'], minutes: [1, 4],
    generates: ['due card queue', 'prompt style per card'],
    events: ['answer', 'rating'],
    marking: 'deterministic',
    pedagogy: 'Retrieval practice beats re-reading, and starting with items you are about to forget is the cheapest win available (spacing effect, Roediger & Karpicke).',
    evidence: ['vocabulary', 'grammar', 'kanji'],
  },
  {
    kind: 'conversation', nameEN: 'Guided conversation', nameJA: '会話', icon: 'chat', modes: ['voice', 'text'], minutes: [3, 12],
    generates: ['setting', 'roles', 'learner goal', 'opening line', 'turn budget', 'hint ladder'],
    events: ['utterance', 'tutor_line', 'hint', 'rating'],
    marking: 'conversational',
    pedagogy: 'Meaning-focused interaction with negotiation of meaning is where acquisition happens. The tutor keeps the conversation real and only interrupts for errors that block understanding.',
    evidence: ['speaking', 'listening', 'interaction'],
  },
  {
    kind: 'quiz', nameEN: 'Quiz', nameJA: 'クイズ', icon: 'check', modes: ['text', 'voice'], minutes: [2, 12],
    generates: ['items with options, answer key, and an explanation of the trap'],
    events: ['answer', 'hint', 'reveal'],
    marking: 'deterministic',
    pedagogy: 'Low-stakes retrieval with immediate, explanatory feedback. Distractors are generated from the learner’s own recurring error tags, so wrong answers are informative rather than random.',
    evidence: ['grammar', 'vocabulary', 'reading', 'listening'],
  },
  {
    kind: 'open_ended', nameEN: 'Open production', nameJA: '自由作文', icon: 'pen', modes: ['text'], minutes: [4, 15],
    generates: ['prompt in JA + EN', 'rubric with weights', 'minimum length'],
    events: ['utterance', 'hint', 'rating'],
    marking: 'rubric',
    pedagogy: 'Extended production forces you to assemble everything you know. Marked on task achievement, range, accuracy, cohesion — the same axes CEFR descriptors use.',
    evidence: ['writing', 'grammar', 'vocabulary'],
  },
  {
    kind: 'reading', nameEN: 'Graded reading', nameJA: '読解', icon: 'book', modes: ['text'], minutes: [3, 12],
    generates: ['passage at 95–98% known-token coverage', 'glossary', 'comprehension items'],
    events: ['answer', 'tool', 'rating'],
    marking: 'deterministic',
    pedagogy: 'Extensive reading works when the text is almost entirely known (Nation: 98% coverage for comfortable comprehension). One or two new items per passage, no more.',
    evidence: ['reading', 'vocabulary', 'kanji'],
  },
  {
    kind: 'listening', nameEN: 'Listening lab', nameJA: '聴解', icon: 'ear', modes: ['voice', 'text'], minutes: [3, 10],
    generates: ['script', 'speed', 'gist question then detail questions'],
    events: ['answer', 'reveal', 'rating'],
    marking: 'deterministic',
    pedagogy: 'Gist first, then detail — the way real listening works. Scripted listening (hear it → read it → hear it again) drives vocabulary acquisition harder than passive exposure.',
    evidence: ['listening'],
  },
  {
    kind: 'shadowing', nameEN: 'Shadowing', nameJA: 'シャドーイング', icon: 'wave', modes: ['voice'], minutes: [2, 6],
    generates: ['short natural lines with a stated focus (mora timing, pitch, contraction)'],
    events: ['utterance', 'rating'],
    marking: 'rubric',
    pedagogy: 'Shadowing builds the phonological loop that underpins both listening and speaking. It is the single highest-yield 3 minutes for an intermediate learner’s accent.',
    evidence: ['speaking', 'listening'],
  },
  {
    kind: 'pronunciation', nameEN: 'Pronunciation clinic', nameJA: '発音クリニック', icon: 'mic', modes: ['voice'], minutes: [2, 8],
    generates: ['minimal pairs / drill set targeted at the learner’s top sound error'],
    events: ['utterance', 'rating'],
    marking: 'rubric',
    pedagogy: 'Visual feedback alone underperforms; visual + narrative feedback produces real gains in intelligibility (Hirschi 2025). So we show the waveform/pitch trace *and* explain it in words.',
    evidence: ['speaking'],
  },
  {
    kind: 'kanji_lab', nameEN: 'Kanji lab', nameJA: '漢字ラボ', icon: 'kanji', modes: ['text'], minutes: [3, 12],
    generates: ['kanji with radical, mnemonic, and 2–3 real words'],
    events: ['answer', 'tool', 'rating'],
    marking: 'deterministic',
    pedagogy: 'Learn kanji as components inside words, never as isolated symbols (hence 言葉 not 字). Test production, not just recognition — recognition is the illusion of knowing.',
    evidence: ['kanji', 'reading', 'vocabulary'],
  },
  {
    kind: 'grammar_focus', nameEN: 'Noticing grammar', nameJA: '文法', icon: 'target', modes: ['text', 'voice'], minutes: [3, 10],
    generates: ['input flood (many examples)', 'input enhancement (highlighted form)', 'guided discovery questions', 'plain-English explanation', 'the classic learner error'],
    events: ['answer', 'hint', 'rating'],
    marking: 'deterministic',
    pedagogy: 'Notice first, explain second: flood the form in context, highlight it, ask the learner what they think the rule is, *then* confirm. Explanation without noticing rarely transfers.',
    evidence: ['grammar', 'reading'],
  },
  {
    kind: 'translation', nameEN: 'Two-way translation', nameJA: '翻訳', icon: 'swap', modes: ['text'], minutes: [3, 8],
    generates: ['source sentences at i+1', 'reference translations', 'the natural-vs-literal trap'],
    events: ['utterance', 'reveal', 'rating'],
    marking: 'rubric',
    pedagogy: 'Pushes you from "understandable" to "natural" — it is where collocation and register errors surface. Marked on naturalness, not literal accuracy.',
    evidence: ['writing', 'grammar', 'vocabulary'],
  },
  {
    kind: 'roleplay', nameEN: 'Real-world task', nameJA: 'ロールプレイ', icon: 'mask', modes: ['voice', 'text'], minutes: [4, 15],
    generates: ['scenario with a concrete outcome ("get the refund")', 'constraints', 'success conditions'],
    events: ['utterance', 'tutor_line', 'hint', 'rating'],
    marking: 'rubric',
    pedagogy: 'Task-based learning: interactional authenticity is what transfers to real life. There is an outcome; the language serves the outcome, not the other way round.',
    evidence: ['speaking', 'interaction', 'listening'],
  },
  {
    kind: 'register', nameEN: 'Register switching', nameJA: '敬語トレーニング', icon: 'levels', modes: ['text', 'voice'], minutes: [4, 10],
    generates: ['the same content restated in casual / 丁寧語 / 尊敬語 / 謙譲語'],
    events: ['utterance', 'answer', 'rating'],
    marking: 'rubric',
    pedagogy: 'Japanese politeness is a system, not a vocabulary list. Drilling the *same message* across registers is what makes the switching automatic under pressure.',
    evidence: ['speaking', 'interaction', 'grammar'],
  },
  {
    kind: 'story', nameEN: 'Story mode', nameJA: '物語', icon: 'sparkle', modes: ['text'], minutes: [5, 15],
    generates: ['a short serialised story continuing from the last episode, using the learner’s due items'],
    events: ['answer', 'rating'],
    marking: 'none',
    pedagogy: 'Compelling input is the only kind that gets processed effortlessly (Krashen). A serial means the learner *wants* tomorrow’s paragraph — retention rides on curiosity.',
    evidence: ['reading', 'vocabulary'],
  },
  {
    kind: 'free_talk', nameEN: 'Just chat', nameJA: '雑談', icon: 'coffee', modes: ['voice', 'text'], minutes: [3, 15],
    generates: ['one interesting question about the learner’s actual life', 'a top-3 correction budget for afterwards'],
    events: ['utterance', 'tutor_line', 'rating'],
    marking: 'conversational',
    pedagogy: 'Fluency and willingness to communicate are built by talking about things that matter to you, with the affective filter down. No agenda, corrections held back for the debrief.',
    evidence: ['speaking', 'interaction'],
  },
  {
    kind: 'recap', nameEN: 'Debrief', nameJA: 'まとめ', icon: 'flag', modes: ['text', 'voice'], minutes: [2, 6],
    generates: ['what worked', 'the 2–3 corrections worth keeping', 'new cards', 'tomorrow’s hook'],
    events: ['rating'],
    marking: 'none',
    pedagogy: 'Delayed, dialogic feedback outperforms interrupting mid-flow for most learners, and a visible "here is what you gained" is what keeps a 6-month learner in the game.',
    evidence: [],
  },
];

export const TOOL_BY_KIND: Record<TaskKind, ToolSpec> = Object.fromEntries(TOOLS.map((t) => [t.kind, t])) as Record<TaskKind, ToolSpec>;

/** Human-readable contract the planner prompt embeds, so the model knows what to produce. */
export function toolContractPrompt(): string {
  return TOOLS.map((t) => (
    `- ${t.kind} (${t.nameJA} / ${t.nameEN}) — ${t.minutes[0]}–${t.minutes[1]} min, modes: ${t.modes.join('/')}, marking: ${t.marking}\n` +
    `    GENERATE: ${t.generates.join('; ')}\n` +
    `    LEARNER EVENTS: ${t.events.join(', ')}`
  )).join('\n');
}

/**
 * Validation gate. A session is never shown to a learner until every beat passes:
 * the model will occasionally return a beat with no opening line, or a passage that is
 * too dense. Better to repair it server-side than to show broken content.
 */
export function validateBeat(beat: any): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!beat?.kind || !TOOL_BY_KIND[beat.kind as TaskKind]) problems.push('unknown task kind');
  if (!beat?.objective) problems.push('missing objective');
  if (typeof beat?.minutes !== 'number' || beat.minutes <= 0) problems.push('missing minutes');
  switch (beat?.kind) {
    case 'conversation':
    case 'roleplay':
    case 'free_talk':
      if (!beat.conversation?.openingLine) problems.push(`${beat.kind}: missing opening line`);
      if (!beat.conversation?.learnerGoal) problems.push(`${beat.kind}: missing learner goal`);
      break;
    case 'quiz':
      if (!Array.isArray(beat.quiz) || beat.quiz.length === 0) problems.push('quiz: no items');
      else for (const q of beat.quiz) {
        if (!q.answer) problems.push(`quiz item ${q.id}: no answer key`);
        if (q.options && !q.options.includes(Array.isArray(q.answer) ? q.answer[0] : q.answer)) problems.push(`quiz item ${q.id}: answer not among options`);
      }
      break;
    case 'reading':
      if (!beat.reading?.text) problems.push('reading: empty passage');
      if (!beat.reading?.questions?.length) problems.push('reading: no comprehension items');
      break;
    case 'listening':
      if (!beat.listening?.script) problems.push('listening: empty script');
      break;
    case 'open_ended':
      if (!beat.openEnded?.promptJA) problems.push('open_ended: no prompt');
      if (!beat.openEnded?.rubric?.length) problems.push('open_ended: no rubric');
      break;
    case 'shadowing':
    case 'pronunciation':
      if (!beat.lines?.length) problems.push(`${beat.kind}: no lines`);
      break;
    case 'kanji_lab':
      if (!beat.kanji?.length) problems.push('kanji_lab: no kanji');
      break;
    case 'grammar_focus':
      if (!beat.grammarPoint?.pattern) problems.push('grammar_focus: no pattern');
      if (!beat.grammarPoint?.inputFlood?.length) problems.push('grammar_focus: no input flood');
      break;
    case 'register':
      if (!beat.extra?.registers) problems.push('register: no register set');
      break;
  }
  return { ok: problems.length === 0, problems };
}

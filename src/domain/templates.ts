/**
 * templates.ts — validated drill templates built from the seed curriculum.
 *
 * These are not a tutor and never run a session on their own. They exist for one
 * purpose: when the live tutor decides mid-session that a 3-minute drill is needed
 * (see /api/session/:id/event → adapt → "inject"), the app supplies the drill from
 * these templates so an injected beat can never fail validateBeat() or break a
 * live lesson. Content comes from content/seed.ts; the decision to use it always
 * comes from the model.
 */

import type { Beat, Target } from '../types';
import { VOCAB, GRAMMAR } from '../content/seed';

const rid = (p: string) => `${p}.${Math.random().toString(36).slice(2, 8)}`;

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

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

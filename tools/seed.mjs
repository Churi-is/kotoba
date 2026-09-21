/**
 * Seeding — builds a realistic learner through the public API so screenshots and
 * audits can jump straight to the interesting screens instead of walking onboarding
 * every time. Uses the x-kotoba-learner header so the identity is fixed and known.
 *
 *   node tools/seed.mjs            → prints the learner id
 *   node tools/seed.mjs fresh      → wipes stored sessions and re-seeds
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ID = process.env.LEARNER || 'L' + 'beefcafe12345678abcd';
const H = { 'content-type': 'application/json', 'x-kotoba-learner': ID };

const call = async (path, body, method) => {
  const res = await fetch(BASE + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), status: res.status }; }
};

// A plausible intermediate learner: A2-ish, works in Japan, struggles with particles
// and pitch, reads better than they listen.
const GOAL = {
  primary: 'work_visa',
  detail: 'I move to Osaka in March for work. I need to survive meetings, read internal docs, and make friends at lunch.',
  targetLevel: 'B1',
  targetJLPT: 'N3',
  realSituations: ['meetings', 'work emails', 'izakaya with colleagues', 'doctor visits'],
};

const PROFILE = {
  goals: GOAL,
  constraints: { minutesPerDay: 25, sessionLength: 20, daysPerWeek: 5, modePreference: 'either', hasMic: true, device: 'desktop' },
  style: {
    correctionTiming: 'end_of_beat', kanjiAppetite: 'cautious', explainIn: 'mostly_japanese',
    interests: ['cooking', 'football', 'city pop', 'train travel'],
    avoidTopics: ['horror'],
    motivationNote: 'My manager switched me to the Osaka team, so this stopped being a hobby.',
    painPoints: ['particles under time pressure', 'keigo with clients', 'listening at natural speed'],
  },
};

async function place() {
  await call('/api/placement/start', { zero: false, name: 'Sam' });
  for (const stage of ['goal', 'background', 'style']) {
    await call('/api/placement/stage', { stage, payload: stage === 'goal' ? GOAL : stage === 'background'
      ? { yearsStudying: 3.5, inJapanMonths: 8, formalClasses: true, priorTests: [{ test: 'JLPT', level: 'N4', score: 112, year: 2025 }], selfRating: {} }
      : { ...PROFILE.style, interests: PROFILE.style.interests } });
  }

  // climb the vocabulary staircase the way a real learner would: right until they miss
  let band = 'A2.1';
  for (let i = 0; i < 9; i++) {
    const { item } = await call('/api/placement/item', { section: 'vocabulary' });
    if (!item) break;
    const half = i % 3 === 2; // miss every third item
    const guess = half ? item.options[(item.options.indexOf(item.explanation) + 1) % item.options.length] : null;
    const target = item.answer ?? item.target;
    const r = await call('/api/placement/answer', { section: 'vocabulary', id: item.id, given: guess ?? target });
    band = r.estimate?.cefr ?? band;
  }
  for (let i = 0; i < 7; i++) {
    const { item } = await call('/api/placement/item', { section: 'grammar' });
    if (!item) break;
    const r = await call('/api/placement/answer', { section: 'grammar', id: item.id, given: i % 2 ? 'ちがう' : (item.target ?? '') });
    band = r.estimate?.cefr ?? band;
  }
  await call('/api/placement/answer', { section: 'script', id: 'kana', given: 'za' }); // recorded as low-confidence evidence

  await call('/api/placement/stage', { stage: 'script', payload: { kana: KANA() } });
  await call('/api/placement/stage', { stage: 'reading', payload: { chars: 412, seconds: 96, correct: 3, total: 4, wpm: 258 } });
  await call('/api/placement/stage', { stage: 'listening', payload: { natural: 0.5, slowed: 0.83, drift: 2 } });
  await call('/api/placement/stage', { stage: 'speaking', payload: { score: 0.58, turns: [
    { role: 'learner', text: 'はい、大阪で 働きます。来年から です。' },
    { role: 'learner', text: 'あの、えっと、むずかしい ですけど、がんばります。' },
    { role: 'learner', text: '私は 東京に 行きました。それから、友だちと ごはんを 食べました。' },
  ] } });
  await call('/api/placement/stage', { stage: 'writing', payload: { score: 0.66, samples: [
    { text: '来週、大阪へ 出張します。ホテルを 予約したいです。部屋が 静かだったら、うれしいです。' },
  ] } });
  await call('/api/placement/stage', { stage: 'interview', payload: { score: 0.6, turns: [
    { role: 'learner', text: '学生の とき、四年間 日本語を 勉強しました。' },
    { role: 'learner', text: '仕事で 使うから、もっと 上手に なりたいです。' },
  ] } });
  return call('/api/placement/finish', {});
}

const KANA = () => [
  { kana: 'あ', given: 'a', correct: true, ms: 620 }, { kana: 'き', given: 'ki', correct: true, ms: 700 },
  { kana: 'し', given: 'shi', correct: true, ms: 810 }, { kana: 'つ', given: 'tsu', correct: true, ms: 1180 },
  { kana: 'ん', given: 'n', correct: true, ms: 640 }, { kana: 'ら', given: 'ra', correct: true, ms: 690 },
  { kana: 'ン', given: 'n', correct: true, ms: 980 }, { kana: 'ツ', given: 'shi', correct: false, ms: 1400 },
  { kana: 'し', given: 'shi', correct: true, ms: 740 }, { kana: 'ュ', given: 'yu', correct: true, ms: 1220 },
  { kana: 'ラ', given: 'ra', correct: true, ms: 900 }, { kana: 'フ', given: 'fu', correct: true, ms: 860 },
];

/** Run a session or three so deck, errors and streaks have real content. */
async function sessionRun(turns) {
  const started = await call('/api/session/start', { minutes: 20 });
  if (!started.plan) return started;
  const plan = started.plan;
  const beads = plan.beats;
  for (const [i, utterance] of turns.entries()) {
    const beat = beads[Math.min(i, beads.length - 1)];
    await call(`/api/session/${plan.id}/event`, {
      ts: Date.now(), beatId: beat.id, type: 'rating',
      payload: { value: ['just_right', 'too_hard', 'just_right', 'more_like_this'][i % 4] },
    });
    await call(`/api/session/${plan.id}/turn`, { beatId: beat.id, text: utterance });
    await call(`/api/session/${plan.id}/beat/${beat.id}/mark`, {
      answers: [{ prompt: beat.titleJA ?? 'れんしゅう', expected: 'correct', given: i === 1 ? 'wrong' : 'correct', correct: i !== 1 }],
      text: utterance,
    });
  }
  await call(`/api/session/${plan.id}/finish`, {});
  return plan;
}

const UTTERANCES = [
  '私は 大阪に 行きます。来週は 会議が あります。',
  '昨日、東京に行いて、友だちに 会いました。',
  'すしは 好きです。でも、なっとうは あまり 好きじゃないです。',
  '部長は 明日 いらっしゃいますか。',
  'えっと、えーと、その、むずかしいですね。',
  '私は コーヒーは 飲みますが、お茶は 飲みません。',
];

if (process.argv.includes('fresh')) {
  const s = await call('/api/progress');
  for (const row of s.sessions ?? []) await call(`/api/session/${row.id}`, undefined, 'DELETE').catch(() => {});
}

await call('/api/learner', PROFILE, 'PATCH');
const placed = await place();
console.log('placement:', placed?.model?.overall ?? placed);
for (let i = 0; i < 3; i++) await sessionRun(UTTERANCES.slice(i, i + 4));
const p = await call('/api/progress');
console.log('sessions:', (p.sessions ?? []).length, '| deck:', p.deck, '| errors:', (p.errors ?? []).length);
console.log('LEARNER=' + ID);

/**
 * prompts.ts — where the pedagogy actually lives.
 *
 * Everything the tutor does is decided by these prompts, so they are treated as
 * product surface, not plumbing: they encode the SLA principles from pedagogy.ts,
 * the tool contract from tasks.ts, and a hard rule that the tutor never invents
 * the learner's level — it reads it from the model and updates it with evidence.
 */

import type { LearnerModel, Profile, SessionPlan, Beat, BeatEvent } from '../types';
import { toolContractPrompt } from '../domain/tasks';
import { targetLanguageRatio, ERROR_TAXONOMY, errorTag, cefrIndex } from '../domain/pedagogy';
import { VOCAB, GRAMMAR, KANJI, SCENARIOS, CANDO } from '../content/seed';

export const TUTOR_PERSONA = `You are Aoi (葵), a private Japanese tutor. One learner, one tutor, every session.

CHARACTER
- Warm, precise, and unshakeably patient. You are the tutor people remember.
- You never perform enthusiasm you don't feel; you get genuinely interested in the learner's actual life.
- You have taste about language: you care whether a sentence *sounds* Japanese, not just whether it is grammatical.

TEACHING RULES (non-negotiable)
1. COMPREHENSIBLE INPUT: aim for 95–98% of what the learner hears/reads to be already known. Introduce at most 1–2 genuinely new items per input task. If you must exceed that, pre-teach.
2. i+1, NEVER i+3: one small step above current ability. Struggle is a signal to scaffold, not to push.
3. CHUNKS FIRST: teach whole usable expressions (お願いします, 〜ていただけますか) before the underlying grammar.
4. NOTICE → DISCOVER → EXPLAIN: when teaching a form, flood it in context, highlight it, ask the learner what they notice, and only then explain.
5. RETRIEVAL OVER RECOGNITION: always prefer "produce it" over "recognise it".
6. DIALOGIC CORRECTION: do not dump corrected sentences. Offer a recast or, better, ask a question that lets the learner repair it themselves (「〜は どう言いますか？」). Reveal the answer only after one attempt, or if they ask.
7. INTERLEAVE: mix old and new, and rarely practise one topic in a block.
8. REGISTER AWARENESS: Japanese politeness is a system. Track whether the learner can hold one register for a whole turn, and whether they know うち/そと.
9. AFFECTIVE FILTER: if the learner is frustrated or bored, change the task type, not just the difficulty. Play matters.
10. NEVER FAKE PROGRESS: do not praise work that has an error in it. Be kind and be honest — that combination is why they will trust you.
11. ROMAJI: never print romaji unless the learner has explicitly asked for it in their profile. Furigana only where their kanji list says they need it.
12. KEEP THE LEARNER TALKING: your turns should usually be shorter than theirs. Ask real questions about their life.

OUTPUT DISCIPLINE
- You are one half of a production system. When asked for JSON, return only JSON that matches the requested shape. No markdown fences, no commentary.
- Japanese you produce must be natural, correctly pitched in register, and written with accurate kanji + kana (furigana in the reading fields, not inline brackets).
- Never invent learner data. If you don't have evidence for a claim about the learner, say what you'd need to find out.`;

// ------------------------------------------------------------------ learner context

export function learnerContext(profile: Profile, model: LearnerModel, extras: {
  dueCards: { surface: string; reading?: string; meaning?: string; kind: string }[];
  recentNotices: { tag: string; quote: string; ts: number }[];
  dueCount: number;
}): string {
  const gaps = Object.entries(model.skills)
    .map(([k, v]) => `${k}: ${v.cefr} (conf ${(v.confidence * 100).toFixed(0)}%, n=${v.evidenceCount})`)
    .join(' | ');

  const topErrors = model.errorProfile
    .filter((e) => !e.resolved)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((e) => `${e.tag}×${e.count} (${errorTag(e.tag).label})`)
    .join(', ') || 'none logged yet';

  const tlRatio = targetLanguageRatio(model.skills.speaking.cefr, profile.style.l1Support);

  return `LEARNER
name: ${profile.name ?? 'anonymous'} · L1: ${profile.l1}
goal: ${profile.goals.primary} — "${profile.goals.detail}"
target: ${profile.goals.targetLevel}${profile.goals.targetJLPT !== 'none' ? ` / ${profile.goals.targetJLPT}` : ''}${profile.goals.deadlineISO ? ` by ${profile.goals.deadlineISO}` : ''}
real situations they need: ${profile.goals.realSituations.join('; ') || 'not specified'}
time: ${profile.constraints.sessionLength} min sessions, ${profile.constraints.daysPerWeek}×/week, prefers ${profile.constraints.modePreference}, mic: ${profile.constraints.hasMic}

BACKGROUND
years studying: ${profile.background.yearsStudying} · formal classes: ${profile.background.formalClasses ? 'yes' : 'no'} · months in Japan: ${profile.background.inJapanMonths}
prior tests: ${profile.background.priorTests.map((t) => `${t.test} ${t.level}${t.score ? ` (${t.score})` : ''} ${t.year ?? ''}`).join(', ') || 'none'}
pain points they told us: ${profile.style.painPoints.join('; ') || 'none stated'}
motivation (their words): ${profile.style.motivationNote || '—'}

CURRENT ABILITY (from evidence, not self-report)
${gaps}
overall ${model.overall.cefr} · JLPT estimate ${model.overall.jlptEstimate} · vocab≈${model.vocabSizeEstimate} · kanji known≈${model.kanjiKnown}
reading ${model.metrics.readingWPM} wpm · listening at native speed ${(model.metrics.listeningAccuracyAtNativeSpeed * 100).toFixed(0)}% · mean utterance ${model.metrics.meanUtteranceLength} · L1 code-switch ${(model.metrics.codeSwitchRate * 100).toFixed(0)}%
interaction: aizuchi ${model.interactionProfile.aizuchiUse}/100 · questions ${model.interactionProfile.questionForming}/100 · repair strategies ${model.interactionProfile.negotiation}/100

RECURRING ERRORS (these are your lesson targets — not the textbook order)
${topErrors}
recent uncorrected quotes: ${extras.recentNotices.slice(0, 4).map((n) => `「${n.quote}」(${n.tag})`).join(' ') || '—'}

STYLE
corrections: ${profile.style.correctionTiming} / ${profile.style.correctionStyle} · L1 support: ${profile.style.l1Support} · romaji: ${profile.style.romaji} · kanji appetite: ${profile.style.kanjiAppetite}
interests: ${profile.style.interests.join(', ') || 'unknown'} · avoid: ${profile.style.avoidTopics.join(', ') || 'nothing'}
target L2 ratio this session: ${(tlRatio * 100).toFixed(0)}%

QUEUE
SRS due now: ${extras.dueCount} cards, e.g. ${extras.dueCards.slice(0, 12).map((c) => `${c.surface}${c.reading ? `(${c.reading})` : ''}=${c.meaning}`).join(', ') || 'none'}
tutor notebook (recent): ${model.notes.slice(-4).join(' | ') || 'empty'}`;
}

// ------------------------------------------------------------------ the planner

export interface PlanRequest {
  profile: Profile;
  model: LearnerModel;
  recipeId: string;
  recipeShape: { kind: string; minutes: number; note: string }[];
  minutes: number;
  mode: 'voice' | 'text';
  goalHint?: string;
  dueCards: { id: string; surface: string; reading?: string; meaning?: string; kind: string; state: string }[];
  recentNotices: { tag: string; quote: string; ts: number }[];
  sessionNumber: number;
  lastSummary?: string;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    titleJA: { type: 'string' },
    titleEN: { type: 'string' },
    theme: { type: 'string' },
    rationale: { type: 'string', description: 'In the tutor’s voice, 2–3 sentences, explaining the plan to the learner. Mention the evidence you used.' },
    canDo: { type: 'array', items: { type: 'string' } },
    focusErrorTags: { type: 'array', items: { type: 'string' } },
    nextSession: { type: 'string' },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          minutes: { type: 'number' },
          titleJA: { type: 'string' },
          titleEN: { type: 'string' },
          objective: { type: 'string' },
          why: { type: 'string' },
          success: { type: 'string' },
          difficulty: { type: 'number' },
          scaffolding: { type: 'array', items: { type: 'string' } },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' }, surface: { type: 'string' }, reading: { type: 'string' },
                meaning: { type: 'string' }, note: { type: 'string' },
              },
            },
          },
          quiz: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, prompt: { type: 'string' },
                options: { type: 'array', items: { type: 'string' } },
                answer: { type: 'string' }, explanation: { type: 'string' },
                audio: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          reading: {
            type: 'object',
            properties: {
              title: { type: 'string' }, text: { type: 'string' },
              glossary: { type: 'array', items: { type: 'object', properties: { surface: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string' } } } },
              questions: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }, explanation: { type: 'string' } } },
              },
            },
          },
          listening: {
            type: 'object',
            properties: {
              title: { type: 'string' }, script: { type: 'string' }, speed: { type: 'number' },
              questions: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }, explanation: { type: 'string' } } },
              },
            },
          },
          conversation: {
            type: 'object',
            properties: {
              setting: { type: 'string' }, tutorRole: { type: 'string' }, learnerRole: { type: 'string' },
              learnerGoal: { type: 'string' }, openingLine: { type: 'string' }, openingTranslation: { type: 'string' },
              constraints: { type: 'array', items: { type: 'string' } },
              hints: { type: 'array', items: { type: 'string' } },
              maxTurns: { type: 'number' },
            },
          },
          openEnded: {
            type: 'object',
            properties: {
              promptJA: { type: 'string' }, promptEN: { type: 'string' }, minLength: { type: 'number' },
              hints: { type: 'array', items: { type: 'string' } },
              rubric: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, weight: { type: 'number' }, descriptor: { type: 'string' } } } },
            },
          },
          lines: {
            type: 'array',
            items: { type: 'object', properties: { ja: { type: 'string' }, reading: { type: 'string' }, en: { type: 'string' }, focus: { type: 'string' } } },
          },
          kanji: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                char: { type: 'string' }, meaning: { type: 'string' },
                onyomi: { type: 'array', items: { type: 'string' } }, kunyomi: { type: 'array', items: { type: 'string' } },
                mnemonic: { type: 'string' },
                words: { type: 'array', items: { type: 'object', properties: { ja: { type: 'string' }, reading: { type: 'string' }, en: { type: 'string' } } } },
              },
            },
          },
          grammarPoint: {
            type: 'object',
            properties: {
              pattern: { type: 'string' }, explanationEN: { type: 'string' },
              examples: { type: 'array', items: { type: 'object', properties: { ja: { type: 'string' }, en: { type: 'string' } } } },
              commonError: { type: 'string' }, inputFlood: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['kind', 'minutes', 'objective', 'why', 'titleJA', 'titleEN'],
      },
    },
  },
  required: ['titleJA', 'titleEN', 'theme', 'rationale', 'beats'],
} as const;

export function plannerPrompt(req: PlanRequest): string {
  const { profile, model, recipeShape, minutes, mode, dueCards } = req;
  const level = model.overall.cefr;
  const i = cefrIndex(level);

  const levelGuidance = [
    'pre-A1/A1: survival chunks, kana reading speed, ます forms, no romaji unless asked, heavy visual/EN scaffolding, expect single-phrase answers.',
    'A2: full て-form and 〜たい/〜ている, transactional scenarios, past tense narration, first connected sentences (3–5), repair phrases.',
    'B1: clause linking (〜ので/〜ながら/〜たら), opinion + reason, keigo basics for work, push utterance length past 2 sentences, start killing は/が and transitivity errors.',
    'B2: register control (尊敬語/謙譲語 switching), nuance and hedging (〜わけではない, 〜とは限らない), long-form reading, disagreeing politely.',
    'C1: naturalness, idiom, pitch accent detail, writing style, specialised vocabulary for their field.',
  ][Math.min(4, Math.max(0, Math.floor(i / 2)))];

  return `Design today's session. Session number ${req.sessionNumber} with this learner.

${learnerContext(profile, model, { dueCards, recentNotices: req.recentNotices, dueCount: dueCards.length })}

SESSION PARAMETERS
length: ${minutes} minutes (hard budget — the sum of beat minutes must land within 10% of this)
mode: ${mode} (${mode === 'voice' ? 'spoken interaction is possible and preferred' : 'text only — no audio expectations, this is a quiet/commute session'})
recipe: ${req.recipeId}
${profile.goals.deadlineISO && profile.goals.targetJLPT !== 'none' ? `exam pressure: JLPT ${profile.goals.targetJLPT} target, be exam-relevant where it helps, but do not turn every session into a mock test.` : ''}
${req.goalHint ? `learner pressed a button implying: ${req.goalHint}` : ''}
${req.lastSummary ? `last session debrief: ${req.lastSummary}` : ''}

LEVEL CALIBRATION FOR ${level}
${levelGuidance}

THE TOOL KIT (choose from these; a beat's kind must be one of them)
${toolContractPrompt()}

HOW TO SHAPE THE SESSION (a real tutor's instincts, not a template)
- Open with retrieval, not exposition. Learners arrive with yesterday's residue; use it.
- The session must have ONE thing it is really about (the 'theme'), and that thing should come from the learner's own recurring errors or their goal situations — in that order of preference.
- Noticing comes before explanation. If you teach grammar, flood → highlight → ask → tell.
- End with a task where they must produce, and make it about their actual life, workplace, or next trip.
- Total minutes: keep each beat inside the tool's range. Do not pad. Three excellent beats beat six thin ones.
- Every input task: keep unknown tokens to 1–2 items and pre-teach them in an earlier beat's targets.
- Write a 'why' for every beat in the learner's language, plain English, one sentence, no jargon. They will read it.
- 'scaffolding' = the hints you will offer if they stall, from lightest to heaviest. The first should be a nudge, the last is basically the answer.
- Put their actual due flashcards into the warmup where they fit naturally.

TARGETING (this is what makes it feel like a private tutor)
- Pick 2–4 items total for the session. Reuse them across beats — in the warmup, inside the reading passage, and as the goal of the final production task. Spaced repetition inside a single session is cheap and effective.
- Target the top recurring errors listed above. If they drop を, engineer a conversation where they cannot avoid it.
- Do not invent a new register problem for a B1 learner who cannot yet hold 丁寧語. Order of operations matters.

VERIFICATION BEFORE YOU ANSWER
- Sum of beat minutes ≈ ${minutes}.
- Every quiz item's answer appears in its options.
- Every listening script is something a human could actually say out loud.
- Difficulty ratings should reflect *this* learner: difficulty 3 means "they will get it, with effort".

Return JSON only, matching the schema.`;
}

// ------------------------------------------------------------------ in-session turns

export function turnSystemPrompt(profile: Profile, model: LearnerModel, beat: Beat, plan: SessionPlan): string {
  const ratio = targetLanguageRatio(model.skills.speaking.cefr, profile.style.l1Support);
  const c = beat.conversation;
  return `${TUTOR_PERSONA}

YOU ARE CURRENTLY IN: ${plan.titleEN} — beat "${beat.titleEN}" (${beat.kind}).
objective: ${beat.objective}
${c ? `scenario: ${c.setting}\nyour role: ${c.tutorRole}\ntheir role: ${c.learnerRole}\ntheir goal: ${c.learnerGoal}\nconstraints: ${c.constraints.join('; ')}\nturn budget: about ${c.maxTurns} learner turns` : ''}
target items to elicit naturally: ${beat.targets.map((t) => t.surface).join(', ') || 'none'}
success condition: ${beat.success}
scaffolding ladder (use the lightest that works): ${beat.scaffolding.join(' → ') || 'just rephrase'}

RUNTIME RULES
- Target ${(ratio * 100).toFixed(0)}% Japanese / L1. ${ratio < 0.7 ? 'You may gloss in English, but keep the Japanese utterances simple and short.' : 'Stay in Japanese; gloss only if they are lost twice.'}
- Correction policy for this learner: ${profile.style.correctionTiming} (${profile.style.correctionStyle}). ${
    profile.style.correctionTiming === 'during'
      ? 'Recast an error in-line, briefly, then continue the conversation. Never stack two corrections in one turn.'
      : profile.style.correctionTiming === 'pause'
      ? 'Allow one error without comment. If the same error type recurs, pause once: "ちょっと止めてもいいですか"' 
      : 'Do not correct during conversation. Note errors for the debrief; only re-ask if their meaning failed.'
  }
- Stay in character. You are a ${c?.tutorRole ?? 'tutor'}, not a language assistant. Do not narrate the grammar mid-conversation.
- One question per turn, usually. Do not quiz them three times in a row.
- Use 相槌 (うん, なるほど, そうですか) naturally so they hear what real listening sounds like.
- If they ask for a translation or say they're lost, drop the register one notch and simplify — do not switch to English wholesale.
- If they use English, respond once in Japanese then, if needed, ask in Japanese how to say it: 「〜は日本語で何と言いますか？」

Apply the learner's current i+1: their level is ${model.overall.cefr}, so your Japanese should be one notch above what they produce, never two.`;
}

export function turnUserPrompt(history: { role: 'tutor' | 'learner'; text: string }[], learnerText: string): string {
  const recent = history.slice(-8).map((h) => `${h.role === 'tutor' ? 'AOI' : 'LEARNER'}: ${h.text}`).join('\n');
  return `${recent ? `CONVERSATION SO FAR\n${recent}\n\n` : ''}LEARNER JUST SAID: ${learnerText}

Reply as Aoi: 1–3 short Japanese sentences. Then optionally, on a new line beginning exactly with "NOTE:", one line of private tutoring note for the debrief log (English, no more than 15 words) — omit it entirely if there is nothing worth noting.`;
}

// ------------------------------------------------------------------ feedback / marking

export const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    achieved: { type: 'string', description: 'Did they meet the beat objective? Honest, one sentence.' },
    band: { type: 'string', description: 'CEFR band this production is evidence for.' },
    wins: { type: 'array', items: { type: 'string' }, description: 'Specific things they did well, quoting their own words.' },
    notices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Their exact words' },
          tag: { type: 'string', description: 'error taxonomy tag' },
          issue: { type: 'string', description: 'Plain English. No jargon, no grammar lecture.' },
          recast: { type: 'string', description: 'How a native would say it — the natural version, not a robot version.' },
          elicit: { type: 'string', description: 'A question in Japanese that gets them to self-repair. Required: dialogic feedback beats dumped corrections.' },
          severity: { type: 'number' },
        },
      },
    },
    targets: {
      type: 'array',
      items: { type: 'object', properties: { kind: { type: 'string' }, surface: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string' }, note: { type: 'string' } } },
      description: 'Only items genuinely worth remembering: 0–4 of them.',
    },
    nextTime: { type: 'string' },
    metrics: {
      type: 'object',
      properties: {
        meanUtteranceLength: { type: 'number' }, selfRepairRate: { type: 'number' }, codeSwitchRate: { type: 'number' },
        aizuchiUse: { type: 'number' }, questionForming: { type: 'number' }, negotiation: { type: 'number' },
        listeningAccuracy: { type: 'number' }, fluencyScore: { type: 'number' },
      },
    },
  },
  required: ['achieved', 'wins', 'notices', 'nextTime'],
} as const;

export function feedbackPrompt(args: {
  profile: Profile; model: LearnerModel; plan: SessionPlan; beat: Beat;
  transcript: { role: 'tutor' | 'learner'; text: string }[];
  answers?: { prompt: string; expected: string; given: string; correct: boolean }[];
  timing: 'during' | 'pause' | 'after';
}): string {
  const { profile, model, beat, transcript, answers } = args;
  const taxonomy = Object.entries(ERROR_TAXONOMY).map(([k, v]) => `${k} [${v.domain}] ${v.label}`).join('\n');
  const learnerTurns = transcript.filter((t) => t.role === 'learner').map((t) => t.text);

  return `Mark this beat and write the debrief for the learner.

BEAT: ${beat.kind} — ${beat.titleEN}
objective: ${beat.objective}
success condition: ${beat.success}
target items: ${beat.targets.map((t) => `${t.surface}(${t.reading ?? ''})= ${t.meaning ?? ''}`).join(', ') || 'none'}
learner level: ${model.overall.cefr} (speaking ${model.skills.speaking.cefr}, writing ${model.skills.writing.cefr})

TRANSCRIPT
${transcript.map((t) => `${t.role === 'tutor' ? 'AOI' : 'LEARNER'}: ${t.text}`).join('\n') || '(no transcript)'}

${answers?.length ? `QUIZ ANSWERS\n${answers.map((a) => `- "${a.prompt}" → expected "${a.expected}", gave "${a.given}" ${a.correct ? '✓' : '✗'}`).join('\n')}` : ''}

ERROR TAXONOMY (use these tags exactly — they feed the learner model that designs future sessions)
${taxonomy}

MARKING RULES
- Judge against the beat objective, not against perfection. A learner who communicated the goal successfully achieved it.
- MAXIMUM 3 notices. Choose the ones that will most change how this learner speaks next time. Frequency and severity both count, but clarity wins: an error they can fix today beats three they can't.
- Every notice needs an 'elicit': a Japanese question that lets them fix it themselves. Then the recast is available if they can't.
- 'wins' must quote their actual words. "Nice work" is worthless; "「〜ていただけますか」 was exactly the right register" is not.
- Set 'targets' from the items that actually came up and are worth keeping. If they already know an item cold, do not add it.
- 'metrics' are your honest estimates from this sample: meanUtteranceLength in morae-ish characters, rates as 0..1 (codeSwitchRate = share of their turns in L1), other fields 0..100. If there is no evidence for a field, omit it rather than guessing.
- 'nextTime' is one sentence addressed to them, about what you'll do next session — make it a promise you can keep.
- Correction preference is "${profile.style.correctionTiming}". If it is "after", never present this as a scolding list; frame it as "the two things worth keeping".

Return JSON only.`;
}

// ------------------------------------------------------------------ placement synthesis

export function placementSynthesisPrompt(args: {
  profile: unknown;
  evidence: unknown;
  selfReport: unknown;
}): string {
  return `You have just finished placing a new learner. Synthesise everything into an honest starting hypothesis.

WHAT THEY TOLD US
${JSON.stringify(args.selfReport, null, 1)}

HARD EVIDENCE COLLECTED
${JSON.stringify(args.evidence, null, 1)}

JUDGEMENT RULES
- Evidence beats self-report, but a high self-report with weak evidence means "rusty, not incapable" — say so, and plan a re-test rather than a remedial spiral.
- Confidence must reflect sample size. 6 vocabulary items → confidence under 0.4. A 5-minute interview → 0.7 for speaking. Never claim above 0.85 on a first placement.
- Skill-specific bands matter more than the overall: a learner can be B1 reading and A2 speaking. That gap is the whole point of finding it.
- For Japanese specifically, judge these separately: kana fluency, kanji recognition vs production, particle accuracy, て-form control, register (丁寧語 vs plain) control, and pitch/mora intelligibility.
- A2.1 is a real level (JFT-Basic uses it from Aug 2026). Use it; it prevents over-claiming A2.
- Give every estimate the evidence it rests on, in plain English, and state the single cheapest thing that would raise confidence in it.

Return JSON with: skills{listening,speaking,reading,writing,vocabulary,grammar,kanji,interaction → {cefr, percentile, confidence, evidenceCount, why}}, overall{cefr, confidence, jlptEstimate, jlptScoreBand}, vocabSizeEstimate, kanjiKnown, scripts{hiragana,katakana,kanji,romaji-free}, metrics{readingWPM, listeningAccuracyAtNativeSpeed, meanUtteranceLength, codeSwitchRate, fluencyScore}, strengths[3], focusAreas[3], firstMonthPlan[4 weekly themes], recommendedRecipe, notes[2-3 tutor-notebook lines], confidenceCaveats[1-3].`;
}

// ------------------------------------------------------------------ content tools

export function glossPrompt(term: string, context: string, level: string): string {
  return `The learner tapped "${term}" inside this context: 「${context}」.
They are at ${level}. Return JSON: {reading (kana), meaningEN (short), pos, pitch (accent pattern as a number like 1, or omit if unsure), note (one line on nuance or collocation, in English), example (one short sentence using it at their level), exampleEN}. If this is an inflected verb or an adjective, give the dictionary form as the surface field and explain the inflection in the note field.`;
}

export function storyPrompt(args: { episode: number; level: string; dueItems: string[]; interests: string[]; previous: string }): string {
  return `Write episode ${args.episode} of a serialised short story for a Japanese learner at ${args.level}.

Interests: ${args.interests.join(', ') || 'slice of life'}
Items they are currently reviewing (use them naturally, do not list them): ${args.dueItems.join(', ')}
${args.previous ? `Previous episode ended: ${args.previous}` : 'This is episode 1 — establish two characters and a small problem.'}

Constraints:
- 120–200 characters of Japanese, natural prose, 95–98% vocabulary from the ${args.level} band.
- Level ${args.level}: ${args.level === 'A2' || args.level === 'A2.1' ? 'short clauses, です/ます or plain consistent narrative form, no more than 2 unknown words.' : 'may use clause linking and 2–3 unknown words glozed at the end.'}
- End on a small hook.
- Return JSON: {titleJA, titleEN, text, glossary:[{surface,reading,meaning}], hook, question (one comprehension question in Japanese with 3 options and an answer)}.`;
}

export function registerPrompt(content: string, registers: string[]): string {
  return `Restate this content in each register: ${registers.join(', ')}.
Content: 「${content}」
Return JSON: { items: [{register, ja, reading, en, note}] } where note explains in one short English line what changed structurally (not just which words), e.g. "humble form: 伺う for my own action; いらっしゃる would be wrong here because I am the one going."`;
}

/** Compact, cache-friendly curriculum digest handed to the planner so it reuses
 *  our frequency-ordered items instead of inventing parallel ones. */
export function curriculumDigest(level: string): string {
  const v = VOCAB.filter((x) => x.level === level).slice(0, 14).map((x) => `${x.surface}(${x.reading})=${x.en}`);
  const g = GRAMMAR.filter((x) => x.level === level).slice(0, 10).map((x) => `${x.pattern} = ${x.en} [trap: ${x.commonError}]`);
  const k = KANJI.filter((x) => x.level === level).slice(0, 10).map((x) => `${x.char}=${x.meaning}`);
  const c = CANDO.filter((x) => x.level === level).slice(0, 8).map((x) => `${x.skill}: ${x.statement}`);
  const s = SCENARIOS.filter((x) => x.level === level).slice(0, 5).map((x) => `${x.titleEN} (${x.register}) — goal: ${x.learnerGoal}`);
  return `CURRICULUM ANCHORS for ${level} (prefer these over inventing equivalents)
vocab: ${v.join(' · ') || 'none in seed'}
grammar: ${g.join(' · ') || 'none in seed'}
kanji: ${k.join(' · ') || 'none in seed'}
scenarios: ${s.join(' · ') || 'none in seed'}
can-do statements: ${c.join(' · ') || 'none in seed'}`;
}

export function debriefPrompt(plan: SessionPlan, transcript: { role: string; text: string }[], timing: string): string {
  const learnerLines = transcript.filter((t) => t.role === 'learner').map((t) => t.text);
  return `The session "${plan.titleEN}" just ended. Write the closing debrief the learner sees.

What happened: ${plan.beats.length} beats, ${learnerLines.length} learner turns.
${timing === 'after' ? 'This learner asked for corrections AFTER the session, so this debrief is where they all land.' : 'Most corrections already happened in-flow, so this debrief should be short and forward-looking.'}

Their production, in order:
${learnerLines.map((l, i) => `${i + 1}. ${l}`).join('\n') || '(nothing captured)'}

Return JSON: {headline (one warm sentence), highlights[2-3 specific wins quoting them], toKeep[2-3 {quote, recast, elicit, tag}], newCards[0-4 {surface,reading,meaning}], canDoAdvanced[string], nextTeaser(string, one sentence in the tutor's voice), notebook(string: 1-2 lines of private notes for your own future planning — what worked, what to do differently)}.`;
}

export function planRepairPrompt(badOutput: string, problems: string[], req: PlanRequest): string {
  return `Your previous session plan failed validation.

PROBLEMS
${problems.map((p) => `- ${p}`).join('\n')}

YOUR PREVIOUS OUTPUT
${badOutput.slice(0, 6000)}

Fix ONLY what is broken and return the complete corrected JSON plan. Keep everything else identical. Constraints reminder: total minutes within 10% of ${req.minutes}; every quiz answer must appear in its options; conversation beats need an openingLine and a learnerGoal.`;
}

export function formatEventForLog(e: BeatEvent): string {
  const p = e.payload as any;
  switch (e.type) {
    case 'answer': return `[${e.beatId}] answered "${p.given}" → ${p.correct ? 'correct' : `expected "${p.expected}"`}`;
    case 'utterance': return `[${e.beatId}] learner: ${p.text}${p.ms ? ` (${Math.round(p.ms / 100) / 10}s)` : ''}`;
    case 'tutor_line': return `[${e.beatId}] tutor: ${p.text}`;
    case 'rating': return `[${e.beatId}] rated: ${p.value}`;
    case 'hint': return `[${e.beatId}] used hint ${p.level}`;
    case 'skip': return `[${e.beatId}] skipped`;
    case 'reveal': return `[${e.beatId}] asked for the answer`;
    case 'tool': return `[${e.beatId}] ${p.tool}: ${JSON.stringify(p.value ?? {})}`;
    default: return `[${e.beatId}] ${e.type}`;
  }
}

/**
 * Kotoba — shared domain types.
 *
 * The whole product hangs off four objects:
 *   Profile      — who the learner is and what they want (onboarding output)
 *   LearnerModel — what we believe they can currently do (living, evidence-backed)
 *   SessionPlan  — what today's lesson is (designed by the AI, rendered by the app)
 *   Beat         — one block of that lesson, executed by one "tool"
 */

export type CEFR = 'pre-A1' | 'A1' | 'A1+' | 'A2.1' | 'A2' | 'A2+' | 'B1' | 'B1+' | 'B2' | 'C1';
export type JLPT = 'none' | 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
export type Skill = 'listening' | 'speaking' | 'reading' | 'writing' | 'vocabulary' | 'grammar' | 'kanji' | 'interaction';

/** Japanese-specific surface features we track as first-class skills. */
export type Script = 'hiragana' | 'katakana' | 'kanji' | 'romaji-free';

export type TaskKind =
  | 'warmup'
  | 'conversation'
  | 'quiz'
  | 'open_ended'
  | 'reading'
  | 'listening'
  | 'shadowing'
  | 'pronunciation'
  | 'kanji_lab'
  | 'grammar_focus'
  | 'translation'
  | 'roleplay'
  | 'register'
  | 'story'
  | 'free_talk'
  | 'recap';

export type Mode = 'voice' | 'text' | 'either';

// ---------------------------------------------------------------- learner

export interface Goals {
  primary: 'travel' | 'jlpt' | 'work_visa' | 'media' | 'family_partner' | 'study_abroad' | 'heritage' | 'fun';
  detail: string;
  targetLevel: CEFR;
  targetJLPT: JLPT;
  deadlineISO?: string;
  /** Where they actually need to use the language, in their words. */
  realSituations: string[];
}

export interface Constraints {
  minutesPerDay: number;
  sessionLength: number; // 5 | 10 | 20 | 30 | 45
  daysPerWeek: number;
  modePreference: Mode;
  hasMic: boolean;
  device: 'phone' | 'desktop' | 'tablet';
  /** Text-to-speech-friendly: commutes, gym, etc. Audio-only sessions. */
  quietEnvironments: boolean;
}

export interface LearningStyle {
  /** Timing of corrective feedback. Research (Kamelabad et al. 2026) shows outcomes are
   *  similar but *preference* differs sharply — so we make it a setting, not a guess. */
  correctionTiming: 'during' | 'pause' | 'after';
  correctionStyle: 'gentle' | 'direct' | 'socratic';
  /** How much English (L1) the tutor may use. */
  l1Support: 'none' | 'hints' | 'explanations' | 'lots';
  romaji: 'always' | 'on_demand' | 'never';
  kanjiAppetite: 'avoid' | 'steady' | 'aggressive';
  pitchAccentInterest: boolean;
  interests: string[];
  avoidTopics: string[];
  /** Self-described history — the AI leans on this to avoid remedial boredom. */
  painPoints: string[];
  motivationNote: string;
}

export interface Profile {
  id: string;
  createdAt: number;
  updatedAt: number;
  name?: string;
  l1: string;
  goals: Goals;
  constraints: Constraints;
  style: LearningStyle;
  background: {
    yearsStudying: number;
    formalClasses: boolean;
    inJapanMonths: number;
    priorTests: { test: 'JLPT' | 'JFT' | 'other'; level: string; score?: number; year?: number }[];
    selfRating: Partial<Record<Skill, number>>; // 1..5
  };
}

export interface SkillEstimate {
  cefr: CEFR;
  /** 0..100 within-band position, so we can show "A2 solid, creeping to A2+". */
  percentile: number;
  confidence: number; // 0..1 — shown honestly in the UI
  evidenceCount: number;
  lastUpdated: number;
}

export interface LearnerModel {
  skills: Record<Skill, SkillEstimate>;
  overall: { cefr: CEFR; confidence: number; jlptEstimate: JLPT; jlptScoreBand?: [number, number] };
  vocabSizeEstimate: number;
  kanjiKnown: number;
  kanjiLearning: number;
  scripts: Record<Script, number>; // 0..1 mastery
  /** Reading/writing measurable rates — real fluency markers. */
  metrics: {
    readingWPM: number;
    listeningAccuracyAtNativeSpeed: number; // 0..1
    meanUtteranceLength: number; // morae/phrase tokens per turn
    selfRepairRate: number;
    codeSwitchRate: number; // share of L1 in production
    fluencyScore: number; // 0..100
  };
  errorProfile: { tag: string; count: number; lastSeen: number; resolved: boolean }[];
  interactionProfile: { aizuchiUse: number; questionForming: number; turnTaking: number; negotiation: number };
  streaks: { current: number; longest: number; totalSessions: number; totalMinutes: number };
  /** Free-text tutor notebook entries, newest last — like the notes a real tutor keeps. */
  notes: string[];
}

// ---------------------------------------------------------------- content

export interface Target {
  kind: 'vocab' | 'grammar' | 'kanji' | 'sound' | 'strategy';
  id?: string;
  surface: string;
  reading?: string;
  meaning?: string;
  note?: string;
}

export interface QuizItem {
  id: string;
  prompt: string;
  /** Stem may contain ____ for a gap. */
  options?: string[];
  answer: string | string[];
  accept?: string[];
  explanation: string;
  audio?: string; // text to speak for listening items
  tags: string[];
  level: CEFR;
  targetIds: string[];
}

export interface ReadingContent {
  title: string;
  text: string;
  glossary: { surface: string; reading: string; meaning: string }[];
  questions: QuizItem[];
  preTeach: Target[];
}

export interface ListeningContent {
  title: string;
  script: string;         // spoken by TTS
  speed: 1 | 0.85 | 1.15;
  questions: QuizItem[];
  transcriptRevealed: boolean;
}

export interface ConversationContent {
  setting: string;
  tutorRole: string;
  learnerRole: string;
  learnerGoal: string;      // "get the express train, and refuse the upsell"
  openingLine: string;      // first thing the tutor says, in Japanese
  openingTranslation: string;
  constraints: string[];    // "no English", "use keigo", "keep it to 4 turns"
  hints: string[];
  targetIds: string[];
  /** Turn budget; the tutor wraps up gracefully if exceeded. */
  maxTurns: number;
}

export interface OpenEndedContent {
  promptJA: string;
  promptEN: string;
  rubric: { criterion: string; weight: number; descriptor: string }[];
  minLength: number;
  hints: string[];
}

export interface Beat {
  id: string;
  kind: TaskKind;
  minutes: number;
  titleJA: string;
  titleEN: string;
  objective: string;
  /** Shown in the "why this?" popover — transparency builds trust and self-regulation. */
  why: string;
  targets: Target[];
  success: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  scaffolding: string[];
  mode: Mode;
  quiz?: QuizItem[];
  reading?: ReadingContent;
  listening?: ListeningContent;
  conversation?: ConversationContent;
  openEnded?: OpenEndedContent;
  /** For shadowing/pronunciation: the exact lines to work on. */
  lines?: { ja: string; reading: string; en: string; focus: string }[];
  kanji?: { char: string; meaning: string; onyomi: string[]; kunyomi: string[]; words: { ja: string; reading: string; en: string }[]; mnemonic: string }[];
  grammarPoint?: { pattern: string; explanationEN: string; examples: { ja: string; en: string }[]; commonError: string; inputFlood: string[] };
  /** Free-form payload for tools that generate late (story, translation, free_talk). */
  extra?: Record<string, unknown>;
}

export interface SessionPlan {
  id: string;
  createdAt: number;
  titleJA: string;
  titleEN: string;
  theme: string;
  /** The tutor explaining the plan in its own voice — the "why" of the whole lesson. */
  rationale: string;
  canDo: string[];
  recipeId: string;
  mode: Mode;
  totalMinutes: number;
  beats: Beat[];
  focusErrorTags: string[];   // error types this plan is quietly targeting
  reviewCardIds: string[];
  nextSession?: string;       // teaser
  /** Provenance for the UI: "designed by gemini-3.8-flash (planner: gemini-3.1-pro-preview)". */
  designedBy: string;
}

// ---------------------------------------------------------------- feedback

export interface Notice {
  /** What the learner actually said/wrote. */
  quote: string;
  tag: string;              // error taxonomy tag
  issue: string;            // plain-English "what went wrong"
  /** Implicit recast — the natural native version. */
  recast: string;
  /** Dialogic move: a question that invites self-repair *before* we reveal the answer.
   *  AI-dialogic feedback outperforms monologic feedback (Hou & Min 2026). */
  elicit: string;
  severity: 1 | 2 | 3;
  targetIds?: string[];
}

export interface Feedback {
  achieved: string;
  band: CEFR;
  wins: string[];
  notices: Notice[];
  /** New items worth keeping — flow straight into SRS. */
  targets: Target[];
  nextTime: string;
  modelPatch?: Partial<LearnerModel>;
  errorTags?: string[];
}

export interface SessionSummary {
  id: string;
  planId: string;
  startedAt: number;
  endedAt: number;
  minutes: number;
  beatsCompleted: number;
  stats: { answered: number; correct: number; spokenTurns: number; writtenTurns: number; hintUses: number; skipped: number };
  feedback: Feedback;
  canDoAdvanced: string[];
  nextTeaser: string;
}

// ---------------------------------------------------------------- infra

export interface Env {
  ASSETS: Fetcher;
  LEARNER: DurableObjectNamespace;
  LIVE: DurableObjectNamespace;
  TASKS?: Queue;
  AI?: Ai;
  CF_AI_GATEWAY_ACCOUNT?: string;
  CF_AI_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  GEMINI_API_KEY?: string;
  SESSION_SECRET?: string;
  AI_MODE?: string;
  GEMINI_BASE?: string;
  MODEL_PLANNER?: string;
  MODEL_TUTOR?: string;
  MODEL_FAST?: string;
  MODEL_LIVE?: string;
  MODEL_LIVE_DEEP?: string;
  MODEL_TTS?: string;
  DEFAULT_L1?: string;
  APP_NAME?: string;
}

export interface BeatEvent {
  type:
    | 'answer'          // quiz/reading/listening answer
    | 'utterance'       // learner speech (transcribed) or writing
    | 'tutor_line'      // what the tutor said
    | 'rating'          // too_easy | too_hard | just_right | boring | lost | more_like_this
    | 'hint'
    | 'skip'
    | 'reveal'          // asked for translation/answer
    | 'beat_complete'
    | 'tool';           // e.g. tap-to-gloss, added card to SRS
  ts: number;
  beatId: string;
  payload: Record<string, unknown>;
}

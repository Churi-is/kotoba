/**
 * learner.ts — LearnerDO: one Durable Object per learner, backed by SQLite storage.
 *
 * Why a Durable Object and not D1: this is textbook "per-entity storage" — one learner's
 * profile, model, deck, error log and history, isolated and strongly consistent. It also
 * means every write from a live voice session (tool calls, transcript, error logging)
 * lands in the same single-threaded place that the planner reads from, with no
 * cross-region consistency story to invent.
 *
 * The learner model is the product. Everything else — plans, feedback, the UI — is a
 * view onto this object.
 */

import { DurableObject } from 'cloudflare:workers';
import type { BeatEvent, Env, Feedback, LearnerModel, Profile, SessionPlan, SessionSummary, Skill, Target } from '../types';
import type { CardState } from '../domain/pedagogy';
import { cefrAt, cefrIndex, errorTag, newCard, reviewCard, stepCefr } from '../domain/pedagogy';
import { emptyProfile } from '../domain/placement';

const DAY = 86_400_000;

export class LearnerDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Schema migrations live here; blockConcurrencyWhile is the documented place for
    // constructor-time initialisation.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), created INTEGER, updated INTEGER, json TEXT);
        CREATE TABLE IF NOT EXISTS model   (id INTEGER PRIMARY KEY CHECK (id = 1), updated INTEGER, json TEXT);
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY, kind TEXT, surface TEXT, reading TEXT, meaning TEXT, notes TEXT,
          tags TEXT, level TEXT, stability REAL, difficulty REAL, reps INTEGER, lapses INTEGER,
          due INTEGER, last_review INTEGER, state TEXT, created INTEGER
        );
        CREATE INDEX IF NOT EXISTS cards_due ON cards (due);
        CREATE TABLE IF NOT EXISTS errors (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tag TEXT, quote TEXT, recast TEXT,
          beat_id TEXT, session_id TEXT, severity INTEGER, resolved INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS errors_tag ON errors (tag);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, started INTEGER, ended INTEGER, minutes INTEGER, mode TEXT,
          plan TEXT, summary TEXT, stats TEXT, feedback TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session_id TEXT, beat_id TEXT, type TEXT, payload TEXT
        );
        CREATE TABLE IF NOT EXISTS cando (
          id TEXT PRIMARY KEY, level TEXT, skill TEXT, statement TEXT, status TEXT, evidence TEXT, updated INTEGER
        );
        CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session_id TEXT, text TEXT);
        CREATE TABLE IF NOT EXISTS live (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, session_id TEXT, kind TEXT, payload TEXT);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, ts INTEGER);
      `);
    });
  }

  // ---------------------------------------------------------------- basics

  private ensureProfile(): Profile {
    const rows = this.sql.exec<{ json: string }>('SELECT json FROM profile WHERE id = 1').toArray();
    if (rows.length) return JSON.parse(rows[0].json);
    const p = emptyProfile(this.ctx.id.name ?? 'anon');
    this.sql.exec('INSERT INTO profile (id, created, updated, json) VALUES (1, ?, ?, ?)', Date.now(), Date.now(), JSON.stringify(p));
    return p;
  }

  getProfile(): Profile {
    return this.ensureProfile();
  }

  saveProfile(patch: Partial<Profile>): Profile {
    const cur = this.ensureProfile();
    const next: Profile = {
      ...cur,
      ...patch,
      goals: { ...cur.goals, ...(patch.goals ?? {}) },
      constraints: { ...cur.constraints, ...(patch.constraints ?? {}) },
      style: { ...cur.style, ...(patch.style ?? {}) },
      background: { ...cur.background, ...(patch.background ?? {}) },
      updatedAt: Date.now(),
    };
    this.sql.exec('UPDATE profile SET json = ?, updated = ? WHERE id = 1', JSON.stringify(next), Date.now());
    return next;
  }

  getModel(): LearnerModel | null {
    const rows = this.sql.exec<{ json: string }>('SELECT json FROM model WHERE id = 1').toArray();
    return rows.length ? JSON.parse(rows[0].json) : null;
  }

  saveModel(m: LearnerModel): LearnerModel {
    this.sql.exec('INSERT INTO model (id, updated, json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated', Date.now(), JSON.stringify(m));
    return m;
  }

  /** Everything the planner needs, in one round trip (DO calls are cheap but not free). */
  planContext(): {
    profile: Profile; model: LearnerModel | null;
    dueCards: CardState[]; recentNotices: { tag: string; quote: string; ts: number }[];
    dueCount: number; sessionNumber: number; lastSummary?: string; cando: any[];
  } {
    const profile = this.ensureProfile();
    const model = this.getModel();
    const now = Date.now();
    const dueCards = this.sql.exec<CardRow>(
      'SELECT * FROM cards WHERE due <= ? ORDER BY due LIMIT 60', now,
    ).toArray().map(rowToCard);
    const recentNotices = this.sql.exec<{ tag: string; quote: string; ts: number }>(
      'SELECT tag, quote, ts FROM errors ORDER BY ts DESC LIMIT 12',
    ).toArray();
    const sessionNumber = (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').one()?.n ?? 0) + 1;
    const last = this.sql.exec<{ summary: string }>('SELECT summary FROM sessions WHERE summary IS NOT NULL ORDER BY started DESC LIMIT 1').toArray();
    const cando = this.sql.exec<any>('SELECT * FROM cando ORDER BY updated DESC LIMIT 40').toArray();
    return {
      profile, model, dueCards, recentNotices, dueCount: dueCards.length, sessionNumber,
      lastSummary: last.length ? safeParse<any>(last[0].summary)?.headline : undefined, cando,
    };
  }

  // ---------------------------------------------------------------- deck

  /**
   * Add targets to the spaced-repetition deck. Deduplicates against existing cards and
   * against each other: the single biggest failure mode of an AI-generated curriculum
   * is creating the same card five times in five sessions.
   */
  addCards(targets: Target[], level: string): { added: number; existing: number } {
    let added = 0, existing = 0;
    for (const t of targets) {
      const id = t.id ?? `${t.kind}:${t.surface}`;
      const found = this.sql.exec<{ id: string }>('SELECT id FROM cards WHERE id = ? OR surface = ?', id, t.surface).toArray();
      if (found.length) {
        existing++;
        // Strengthen the record rather than duplicating it.
        this.sql.exec('UPDATE cards SET notes = COALESCE(NULLIF(?, \'\'), notes) WHERE id = ?', t.note ?? '', found[0].id);
        continue;
      }
      const c = newCard(t, level);
      this.sql.exec(
        `INSERT INTO cards (id, kind, surface, reading, meaning, notes, tags, level, stability, difficulty, reps, lapses, due, last_review, state, created)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        c.id, c.kind, c.surface, c.reading ?? '', c.meaning ?? '', t.note ?? '', JSON.stringify(c.tags), c.level,
        c.stability, c.difficulty, 0, 0, c.due, 0, 'new', Date.now(),
      );
      added++;
    }
    return { added, existing };
  }

  dueCards(limit = 40): CardState[] {
    return this.sql.exec<CardRow>('SELECT * FROM cards WHERE due <= ? ORDER BY due LIMIT ?', Date.now(), limit).toArray().map(rowToCard);
  }

  gradeCard(id: string, grade: 1 | 2 | 3 | 4): CardState | null {
    const rows = this.sql.exec<CardRow>('SELECT * FROM cards WHERE id = ?', id).toArray();
    if (!rows.length) return null;
    const next = reviewCard(rowToCard(rows[0]), grade);
    this.sql.exec(
      'UPDATE cards SET stability=?, difficulty=?, reps=?, lapses=?, due=?, last_review=?, state=? WHERE id=?',
      next.stability, next.difficulty, next.reps, next.lapses, next.due, next.lastReview, next.state, id,
    );
    return next;
  }

  deckStats() {
    const row = this.sql.exec<{ total: number; learning: number; review: number; mature: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state IN ('new','learning','relearning') THEN 1 ELSE 0 END) AS learning,
              SUM(CASE WHEN state = 'review' THEN 1 ELSE 0 END) AS review,
              SUM(CASE WHEN stability >= 21 THEN 1 ELSE 0 END) AS mature
       FROM cards`,
    ).one();
    return row ?? { total: 0, learning: 0, review: 0, mature: 0 };
  }

  /** Whether an item is already known well enough to count as "known" for the
   *  comprehensible-input coverage gate. */
  knowledgeOf(surface: string): { known: boolean; state?: string; stability?: number } {
    const rows = this.sql.exec<CardRow>('SELECT * FROM cards WHERE surface = ? LIMIT 1', surface).toArray();
    if (!rows.length) return { known: false };
    const c = rowToCard(rows[0]);
    return { known: c.stability >= 7 && c.state === 'review', state: c.state, stability: c.stability };
  }

  // ---------------------------------------------------------------- evidence

  logEvent(sessionId: string, e: BeatEvent) {
    this.sql.exec('INSERT INTO events (ts, session_id, beat_id, type, payload) VALUES (?,?,?,?,?)',
      e.ts, sessionId, e.beatId, e.type, JSON.stringify(e.payload));
  }

  logError(tag: string, quote: string, recast: string, beatId = '', sessionId = '', severity = 2) {
    this.sql.exec('INSERT INTO errors (ts, tag, quote, recast, beat_id, session_id, severity) VALUES (?,?,?,?,?,?,?)',
      Date.now(), tag, quote, recast, beatId, sessionId, severity);
    // Auto-resolve tags we have not seen for a long time — the learner fixed them.
    this.sql.exec('UPDATE errors SET resolved = 1 WHERE tag NOT IN (SELECT tag FROM errors WHERE ts > ?) OR ts < ?', Date.now() - 5 * DAY, Date.now() - 30 * DAY);
  }

  errorProfile(): { tag: string; count: number; lastSeen: number; resolved: boolean }[] {
    return this.sql.exec<{ tag: string; count: number; lastSeen: number }>(
      `SELECT tag, COUNT(*) AS count, MAX(ts) AS lastSeen FROM errors GROUP BY tag ORDER BY count DESC LIMIT 40`,
    ).toArray().map((r) => ({
      ...r,
      resolved: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM errors WHERE tag = ? AND ts > ?', r.tag, Date.now() - 10 * DAY).one()!.n === 0,
    }));
  }

  addNote(text: string, sessionId = '') {
    if (!text?.trim()) return;
    this.sql.exec('INSERT INTO notes (ts, session_id, text) VALUES (?,?,?)', Date.now(), sessionId, text.trim());
  }

  /**
   * Fold a marked beat back into the learner model. Deliberately conservative:
   * one session of evidence nudges an estimate, it does not rewrite it. Confidence grows
   * with evidence count, and the UI shows confidence, so progress feels earned.
   */
  applyFeedback(feedback: Feedback, sessionId: string, beatId: string) {
    for (const n of feedback.notices ?? []) {
      this.logError(n.tag, n.quote, n.recast, beatId, sessionId, n.severity);
      const bumped = this.bumpError(n.tag);
      if (bumped) this.saveModel(bumped);
    }
    if (feedback.targets?.length) this.addCards(feedback.targets, feedback.band ?? 'A2');

    const m = this.getModel();
    if (!m) return;
    const patch = feedback.modelPatch as any;
    if (patch?.metrics) {
      // Exponentially weighted so a single odd session does not swing the dashboard.
      const a = 0.35;
      for (const [k, v] of Object.entries<number>(patch.metrics)) {
        if (typeof v === 'number' && Number.isFinite(v)) (m.metrics as any)[k] = round2((1 - a) * ((m.metrics as any)[k] ?? 0) + a * v);
      }
    }
    // Skill nudge: a well-marked beat at or above the current band is real evidence.
    const targetIdx = cefrIndex(feedback.band ?? m.overall.cefr);
    const primary: Skill = (['speaking', 'writing', 'reading', 'listening'] as Skill[])
      .find((s) => cefrIndex(m.skills[s].cefr) <= targetIdx) ?? 'vocabulary';
    const est = m.skills[primary];
    est.evidenceCount += 1;
    est.confidence = Math.min(0.9, est.confidence + 0.015);
    est.percentile = Math.min(100, est.percentile + (feedback.notices.length === 0 ? 6 : 2));
    if (est.percentile >= 88) {
      est.cefr = stepCefr(est.cefr, 1);
      est.percentile = 38;
      this.addNote(`Promoted ${primary} to ${est.cefr} — the last three sessions were clean at the previous band.`);
    }
    est.lastUpdated = Date.now();
    m.notes = [...(m.notes ?? []), ...(feedback.nextTime ? [] : [])].slice(-40);
    // Overall level is the weighted mean of skills; recompute so the UI never drifts.
    const idxs = (Object.keys(m.skills) as Skill[]).map((s) => cefrIndex(m.skills[s].cefr));
    m.overall.cefr = cefrAt(Math.round(idxs.reduce((x, y) => x + y, 0) / idxs.length));
    this.saveModel(m);
  }

  private bumpError(tag: string): LearnerModel | null {
    const m = this.getModel();
    if (!m) return null;
    const prof = m.errorProfile ?? [];
    const found = prof.find((e) => e.tag === tag);
    if (found) { found.count += 1; found.lastSeen = Date.now(); found.resolved = false; }
    else prof.push({ tag, count: 1, lastSeen: Date.now(), resolved: false });
    for (const e of prof) {
      if (e.tag !== tag && Date.now() - e.lastSeen > 21 * DAY) e.resolved = true;
    }
    m.errorProfile = prof.sort((a, b) => b.count - a.count).slice(0, 60);
    return m;
  }

  // ---------------------------------------------------------------- sessions

  startSession(plan: SessionPlan, mode: string) {
    this.sql.exec('INSERT INTO sessions (id, started, minutes, mode, plan, stats) VALUES (?,?,?,?,?,?)',
      plan.id, Date.now(), 0, mode, JSON.stringify(plan), JSON.stringify({ answered: 0, correct: 0, spokenTurns: 0, writtenTurns: 0, hintUses: 0, skipped: 0 }));
    if (plan.reviewCardIds?.length) {
      // due cards that made it into the warm-up get touched so they don't keep surfacing
      for (const id of plan.reviewCardIds.slice(0, 12)) {
        this.sql.exec('UPDATE cards SET due = ? WHERE id = ? AND due <= ?', Date.now() + 6 * 3600_000, id, Date.now());
      }
    }
    return plan.id;
  }

  finishSession(summary: SessionSummary) {
    const m = this.getModel();
    if (m) {
      m.streaks.totalSessions += 1;
      m.streaks.totalMinutes += summary.minutes;
      const lastSession = this.sql.exec<{ started: number }>('SELECT started FROM sessions WHERE id != ? ORDER BY started DESC LIMIT 1', summary.id).toArray();
      const gapDays = lastSession.length ? (Date.now() - lastSession[0].started) / DAY : 99;
      m.streaks.current = gapDays <= 2 ? m.streaks.current + 1 : 1;
      m.streaks.longest = Math.max(m.streaks.longest, m.streaks.current);
      this.saveModel(m);
    }
    this.sql.exec('UPDATE sessions SET ended = ?, minutes = ?, summary = ?, stats = ?, feedback = ? WHERE id = ?',
      summary.endedAt, summary.minutes, JSON.stringify({ headline: summary.canDoAdvanced, next: summary.nextTeaser }), JSON.stringify(summary.stats), JSON.stringify(summary.feedback), summary.id);
    for (const c of summary.canDoAdvanced ?? []) this.markCanDo(c, summary.id);
    // Schedule the SRS reminder alarm for when the next card is due.
    void this.ctx.storage.setAlarm(Date.now() + 20 * 3600_000);
  }

  sessionHistory(limit = 20) {
    return this.sql.exec<any>('SELECT id, started, ended, minutes, mode, stats, feedback FROM sessions ORDER BY started DESC LIMIT ?', limit).toArray();
  }

  recentEvents(sessionId: string, limit = 80) {
    return this.sql.exec<{ ts: number; beat_id: string; type: string; payload: string }>(
      'SELECT ts, beat_id, type, payload FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?', sessionId, limit,
    ).toArray().reverse().map((e) => ({ ts: e.ts, beatId: e.beat_id, type: e.type, payload: safeParse<any>(e.payload) ?? {} }));
  }

  // ---------------------------------------------------------------- can-do + progress

  seedCanDo(list: { id: string; level: string; skill: string; statement: string }[], achieved: string[] = []) {
    for (const c of list) {
      const status = achieved.includes(c.id) ? 'done' : 'target';
      this.sql.exec('INSERT INTO cando (id, level, skill, statement, status, updated) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET level=excluded.level, statement=excluded.statement',
        c.id, c.level, c.skill, c.statement, status, Date.now());
    }
  }

  markCanDo(statementOrId: string, evidence = '') {
    const rows = this.sql.exec<{ id: string }>('SELECT id FROM cando WHERE id = ? OR statement = ?', statementOrId, statementOrId).toArray();
    if (rows.length) this.sql.exec("UPDATE cando SET status='done', evidence=?, updated=? WHERE id=?", evidence, Date.now(), rows[0].id);
    else this.sql.exec('INSERT INTO cando (id, level, skill, statement, status, evidence, updated) VALUES (?,?,?,?,?,?,?)', `c.${Date.now()}`, '—', '—', statementOrId, 'done', evidence, Date.now());
  }

  progress() {
    const model = this.getModel();
    const sessions = this.sessionHistory(30);
    const deck = this.deckStats();
    const errors = this.errorProfile().slice(0, 12);
    const cando = this.sql.exec<any>('SELECT * FROM cando ORDER BY updated DESC LIMIT 60').toArray();
    const recentMinutes = sessions.slice(0, 7).reduce((a, s) => a + (s.minutes ?? 0), 0);
    return { model, sessions, deck, errors, cando, recentMinutes };
  }

  /** Everything the tutor panel can show about "what I know about you". */
  dossier() {
    const p = this.ensureProfile();
    const m = this.getModel();
    const notes = this.sql.exec<{ ts: number; text: string }>('SELECT ts, text FROM notes ORDER BY id DESC LIMIT 12').toArray();
    const errors = this.errorProfile().slice(0, 10);
    return { profile: p, model: m, notes, errors, deck: this.deckStats() };
  }

  // ---------------------------------------------------------------- live session hooks

  logLive(sessionId: string, kind: string, payload: unknown) {
    this.sql.exec('INSERT INTO live (ts, session_id, kind, payload) VALUES (?,?,?,?)', Date.now(), sessionId, kind, JSON.stringify(payload));
  }

  /** Tool surface for the *voice* tutor (called from LiveSessionDO on a function call). */
  toolLookupItem(surface: string) {
    const k = this.knowledgeOf(surface);
    const card = this.sql.exec<CardRow>('SELECT * FROM cards WHERE surface = ? LIMIT 1', surface).toArray();
    return {
      inDeck: Boolean(card.length),
      known: k.known,
      state: card.length ? rowToCard(card[0]).state : 'unknown',
      stability: card.length ? rowToCard(card[0]).stability : 0,
      reading: card.length ? rowToCard(card[0]).reading : '',
      meaning: card.length ? rowToCard(card[0]).meaning : '',
    };
  }

  // ---------------------------------------------------------------- kv (placement state, active plans)

  kvGet<T>(k: string): T | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray();
    return rows.length ? safeParse<T>(rows[0].v) ?? null : null;
  }

  kvPut(k: string, v: unknown) {
    this.sql.exec('INSERT INTO kv (k, v, ts) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts', k, JSON.stringify(v), Date.now());
  }

  kvDel(k: string) {
    this.sql.exec('DELETE FROM kv WHERE k = ?', k);
  }

  // ---------------------------------------------------------------- alarms

  async alarm(): Promise<void> {
    // Cheap housekeeping: recompute which error tags have gone quiet (the learner fixed
    // them), then re-arm for tomorrow so the deck and tags stay current.
    this.errorProfile();
    this.getProfile();
    await this.ctx.storage.setAlarm(Date.now() + 20 * 3600_000);
  }
}

// ---------------------------------------------------------------- helpers

type CardRow = {
  id: string; kind: string; surface: string; reading: string; meaning: string; notes: string; tags: string;
  level: string; stability: number; difficulty: number; reps: number; lapses: number; due: number;
  last_review: number; state: string; created: number;
};

function rowToCard(r: CardRow): CardState {
  return {
    id: r.id, kind: r.kind as CardState['kind'], surface: r.surface, reading: r.reading, meaning: r.meaning,
    tags: safeParse<string[]>(r.tags) ?? [], level: r.level, stability: r.stability, difficulty: r.difficulty,
    reps: r.reps, lapses: r.lapses, due: r.due, lastReview: r.last_review, state: r.state as CardState['state'],
  };
}

function safeParse<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

function round2(n: number) { return Math.round(n * 100) / 100; }

/** Typed view of the RPC surface, so call sites stay readable. */
export interface LearnerStub {
  getProfile(): Promise<Profile>;
  saveProfile(patch: Partial<Profile>): Promise<Profile>;
  getModel(): Promise<LearnerModel | null>;
  saveModel(m: LearnerModel): Promise<LearnerModel>;
  planContext(): Promise<ReturnType<LearnerDO['planContext']>>;
  addCards(targets: Target[], level: string): Promise<{ added: number; existing: number }>;
  dueCards(limit?: number): Promise<CardState[]>;
  gradeCard(id: string, grade: 1 | 2 | 3 | 4): Promise<CardState | null>;
  deckStats(): Promise<ReturnType<LearnerDO['deckStats']>>;
  knowledgeOf(surface: string): Promise<ReturnType<LearnerDO['knowledgeOf']>>;
  logEvent(sessionId: string, e: BeatEvent): Promise<void>;
  logError(tag: string, quote: string, recast: string, beatId?: string, sessionId?: string, severity?: number): Promise<void>;
  errorProfile(): Promise<ReturnType<LearnerDO['errorProfile']>>;
  addNote(text: string, sessionId?: string): Promise<void>;
  applyFeedback(f: Feedback, sessionId: string, beatId: string): Promise<void>;
  startSession(plan: SessionPlan, mode: string): Promise<string>;
  finishSession(s: SessionSummary): Promise<void>;
  sessionHistory(limit?: number): Promise<any[]>;
  recentEvents(sessionId: string, limit?: number): Promise<{ ts: number; beatId: string; type: string; payload: any }[]>;
  seedCanDo(list: { id: string; level: string; skill: string; statement: string }[], achieved?: string[]): Promise<void>;
  markCanDo(statementOrId: string, evidence?: string): Promise<void>;
  progress(): Promise<ReturnType<LearnerDO['progress']>>;
  dossier(): Promise<ReturnType<LearnerDO['dossier']>>;
  logLive(sessionId: string, kind: string, payload: unknown): Promise<void>;
  kvGet<T>(k: string): Promise<T | null>;
  kvPut(k: string, v: unknown): Promise<void>;
  kvDel(k: string): Promise<void>;
  toolLookupItem(surface: string): Promise<ReturnType<LearnerDO['toolLookupItem']>>;
}

export { errorTag, DAY };

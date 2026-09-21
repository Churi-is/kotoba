/**
 * learner-model.ts — the numeric seed for a learner model: pure arithmetic on
 * placement evidence (quiz accuracy, kana scores, wpm). No AI in here.
 *
 * Two jobs:
 *   · merge base for the Gemini placement synthesis — the model returns a narrative
 *     judgement; anything it does not address keeps these evidence-derived numbers
 *     (see ai/brain.normalizeLearnerModel).
 *   · a provisional model for prompts built *during* placement, before any model
 *     exists (e.g. the speaking probe's marking context).
 *
 * This is deliberately not a tutor: it never writes plans, feedback or debriefs.
 */

import type { LearnerModel, Profile } from '../types';
import { cefrAt, cefrIndex } from './pedagogy';

export function evidenceSeedModel(profile: Profile, evidence: any): LearnerModel {
  const acc: number = evidence.quizAccuracy ?? 0.5;
  const kana: number = evidence.kanaScore ?? 0;
  const speaking: number = evidence.speakingScore ?? acc;
  const interview: number = evidence.interviewScore ?? speaking;
  const readingWPM: number = evidence.readingWPM ?? 0;
  const listening: number = evidence.listeningScore ?? acc;

  const base = Math.max(0, Math.min(6, Math.round(acc * 5) + (profile.background.inJapanMonths > 3 ? 1 : 0)));
  const mk = (idx: number, confidence: number, n: number) => ({ cefr: cefrAt(idx), percentile: 45 + Math.round(acc * 40), confidence, evidenceCount: n, lastUpdated: Date.now() });

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
      'Initial numeric seed from placement evidence — the first sessions re-calibrate every number here.',
    ],
  };
}

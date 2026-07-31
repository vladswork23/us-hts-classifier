import type { HtsClassifyResult } from './types';

/**
 * Deterministic confidence calibration (no LLM call).
 *
 * The model's self-reported confidence is poorly calibrated — it will say
 * "High 90" on a wrong code. This re-derives confidence from OBJECTIVE signals
 * we collect during/after classification: whether the code is a real HTS line
 * (grounding), whether the adversarial verifier confirmed or revised it,
 * whether CBP CROSS precedent agrees at the 6-digit HS level, whether the
 * alternatives span chapters (genuine ambiguity), and whether the code resolved
 * to 10 digits. The result is an explainable confidence + the reasons.
 */

export interface Calibration {
  confidence: 'High' | 'Medium' | 'Low';
  confidence_pct: number;
  needs_human_review: boolean;
  /** Human-readable reasons the score moved, for transparency / the UI. */
  signals: string[];
}

function digits(s: string | undefined): string {
  return (s || '').replace(/\D/g, '');
}

export function calibrateConfidence(result: HtsClassifyResult): Calibration {
  // Base from the model's own band, blended with its self-reported pct if sane.
  const band = result.confidence;
  const bandBase = band === 'High' ? 82 : band === 'Medium' ? 60 : 38;
  const pct = result.confidence_pct;
  let score =
    Number.isFinite(pct) && pct > 0 && pct <= 100 ? Math.round((bandBase + pct) / 2) : bandBase;

  const signals: string[] = [];

  // 1. Code validity (DB grounding).
  if (result.code_valid === false) {
    score -= 35;
    signals.push('chosen code not found in current HTS (−)');
  } else if (result.code_valid === true) {
    score += 4;
  }

  // 2. Adversarial verifier verdict.
  if (result.verification?.verdict === 'revise') {
    score -= 12;
    signals.push('verifier revised the code (−)');
  } else if (result.verification?.verdict === 'confirm') {
    score += 8;
    signals.push('verifier confirmed (+)');
  }

  // 3. CBP CROSS precedent agreement at the 6-digit HS level.
  const code6 = digits(result.hs_code).slice(0, 6);
  const rulings = result.supporting_rulings || [];
  if (rulings.length && code6.length === 6) {
    const agree = rulings.some((r) => digits(r.code).slice(0, 6) === code6);
    if (agree) {
      score += 10;
      signals.push('CROSS precedent agrees at HS6 (+)');
    } else {
      score -= 14;
      signals.push('CROSS precedent disagrees at HS6 (−)');
    }
  } else if (!rulings.length) {
    score -= 4;
    signals.push('no CROSS precedent found');
  }

  // 4. Alternatives spanning chapters => genuine ambiguity about the basket.
  const ownCh = digits(result.hs_code).slice(0, 2);
  const altChapters = new Set(
    (result.alternatives || []).map((a) => digits(a.code).slice(0, 2)).filter(Boolean),
  );
  if (ownCh && [...altChapters].some((c) => c !== ownCh)) {
    score -= 8;
    signals.push('alternatives span multiple chapters (−)');
  }

  // 5. Code not resolved to a full 10-digit statistical suffix.
  if (digits(result.hs_code).length < 10) {
    score -= 6;
    signals.push('code not resolved to 10 digits (−)');
  }

  // 6. The model itself flagged ambiguity.
  if (result.needs_clarification) {
    score -= 10;
    signals.push('model flagged ambiguity (−)');
  }

  score = Math.max(1, Math.min(99, Math.round(score)));
  const calibratedBand: 'High' | 'Medium' | 'Low' =
    score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low';

  const needs_human_review =
    calibratedBand === 'Low' ||
    result.code_valid === false ||
    result.verification?.verdict === 'revise' ||
    Boolean(result.needs_human_review);

  return { confidence: calibratedBand, confidence_pct: score, needs_human_review, signals };
}

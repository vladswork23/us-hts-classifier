import { HTS_SYSTEM_PROMPT } from './prompt';
import { htsToolDefs, runDataTool, groundFinalCode } from './tools';
import { chapterOf } from './sections';
import { verifyClassification } from './verify';
import { calibrateConfidence } from './calibrate';
import { htsConfigured } from './db/client';
import { langfuseEnabled, getLangfuse, flushLangfuse } from './langfuse';
import type { LangfuseTraceClient } from 'langfuse';
import type {
  ClassifyOptions,
  ClassifyOutcome,
  ClassifyTraceEntry,
  HtsClassifyResult,
} from './types';

/**
 * The HTS classification agent.
 *
 * Provider: OpenAI directly (Responses API) via raw fetch, so we do not have to
 * bump the shared `openai` SDK the live app uses. The loop chains turns with
 * `previous_response_id` so the model's reasoning carries across tool calls
 * (the main reason we're on the Responses API). It ends when the model calls
 * the terminal `submit_classification` tool.
 *
 * Pure function: no auth, no DB writes, no HTTP framework. The route and the
 * eval harness both call this directly.
 */

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

// Approximate USD per 1M tokens. Informational only (shown in eval/usage).
// Adjust to current OpenAI pricing as needed.
const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5': { in: 1.25, out: 10.0 },
};

function estimateCost(model: string, inTok: number, outTok: number): number {
  const key = PRICES[model] ? model : Object.keys(PRICES).find((k) => model.includes(k));
  const p = key ? PRICES[key] : undefined;
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

function safeParse<T = any>(s: unknown): T | null {
  if (typeof s !== 'string') return (s as T) ?? null;
  try {
    return JSON.parse(s) as T;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function appendNote(existing: string, add: string): string {
  return existing && existing.trim() ? `${existing.trim()} ${add}` : add;
}

/**
 * Finalization step (always runs, no LLM call): validate the chosen code against
 * the loaded HTS schedule. If valid, overwrite the duty fields with the
 * authoritative DB rates; if not, flag for review and append nearest real codes.
 */
async function applyGrounding(result: HtsClassifyResult): Promise<void> {
  if (!result.hs_code) return;
  try {
    let g = await groundFinalCode(result.hs_code);

    // Deterministic suffix completion: when the schedule implies a single
    // 10-digit statistical line (the code is valid but short, or its suffix is
    // stale/hallucinated and the 8-digit line has exactly one current child),
    // snap to that line. The 8-digit classification — where duty is decided —
    // is unchanged; only the unambiguous statistical suffix is filled in.
    if (g.completion) {
      const original = result.hs_code;
      result.hs_code = g.completion;
      result.notes = appendNote(
        result.notes,
        `[Auto-check] ${original} resolved to the only current statistical line ${g.completion}.`,
      );
      g = await groundFinalCode(g.completion);
    }

    result.code_valid = g.valid;
    if (g.valid) {
      if (g.general) result.duty_general = g.general;
      if (g.special) result.fta_special = g.special;
    } else {
      result.needs_human_review = true;
      const hint = g.nearest.length ? ` Nearest valid codes: ${g.nearest.join(', ')}.` : '';
      result.notes = appendNote(
        result.notes,
        `[Auto-check] Code ${result.hs_code} was not found in the current HTS data — verify the statistical suffix.${hint}`,
      );
    }
  } catch {
    // grounding is best-effort; never block the answer
  }
}

function fallbackResult(productText: string, reason: string): HtsClassifyResult {
  return {
    hs_code: '',
    product: productText.slice(0, 120),
    confidence: 'Low',
    confidence_pct: 0,
    gri_path: '',
    reasoning: `The agent did not converge on a classification: ${reason}`,
    hierarchy: { section: '', chapter: '', heading: '', subheading: '' },
    alternatives: [],
    supporting_rulings: [],
    ch99_overlay: '',
    duty_general: '',
    fta_special: '',
    notes: reason,
    needs_clarification: true,
    clarifying_question: 'Could you provide more detail about the product (material, function, and use)?',
    needs_human_review: true,
  };
}

export async function classifyHts(
  productText: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyOutcome> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');
  if (!htsConfigured()) {
    throw new Error('HTS_DATABASE_URL is not set — the HTS classifier needs its local Postgres DB.');
  }

  const model = opts.model || process.env.HTS_MODEL || 'gpt-5-mini';
  const effort = process.env.HTS_REASONING_EFFORT || 'medium';
  const maxOutputTokens = Number(process.env.HTS_MAX_OUTPUT_TOKENS || 16000);
  const maxRounds = opts.maxRounds ?? 12;
  const startTime = Date.now();

  const trace: ClassifyTraceEntry[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let toolCalls = 0;
  let rounds = 0;
  let previousResponseId: string | undefined;
  let input: any[] = [{ role: 'user', content: productText }];
  let result: HtsClassifyResult | null = null;
  let forcedSubmit = false;
  const notesRead = new Set<string>(); // chapters the agent has called get_notes for
  let notesEnforced = false; // we require "read notes before submit" at most once

  // Langfuse: one trace per classifyHts() call, a generation per round-trip to
  // the model, and a span per tool call — mirrors the ClassifyTraceEntry[]
  // above but visible in the Langfuse UI (prompts, timings, cost, nesting).
  // No-op (lfTrace stays undefined) when LANGFUSE_* env vars are not set.
  const lf = langfuseEnabled() ? getLangfuse() : null;
  const lfTrace: LangfuseTraceClient | undefined = lf?.trace({
    name: 'classifyHts',
    input: productText,
    sessionId: opts.sessionId,
    metadata: { model, reasoningEffort: effort },
  });

  while (rounds < maxRounds) {
    rounds++;

    const body: Record<string, unknown> = {
      model,
      tools: htsToolDefs,
      tool_choice: forcedSubmit ? { type: 'function', name: 'submit_classification' } : 'auto',
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      input,
    };
    if (previousResponseId) body.previous_response_id = previousResponseId;
    else body.instructions = HTS_SYSTEM_PROMPT;

    const lfGen = lfTrace?.generation({
      name: `round-${rounds}`,
      model,
      modelParameters: { reasoning_effort: effort, max_output_tokens: maxOutputTokens },
      input: previousResponseId ? input : [{ role: 'system', content: HTS_SYSTEM_PROMPT }, ...input],
    });

    let resp: Response;
    try {
      resp = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(180000),
      });
    } catch (e: any) {
      lfGen?.end({ level: 'ERROR', statusMessage: e?.message || String(e) });
      throw e;
    }

    if (!resp.ok) {
      const txt = await resp.text();
      lfGen?.end({ level: 'ERROR', statusMessage: `HTTP ${resp.status}: ${txt.slice(0, 500)}` });
      throw new Error(`OpenAI Responses API error ${resp.status}: ${txt.slice(0, 500)}`);
    }

    const data: any = await resp.json();
    previousResponseId = data.id;
    totalIn += Number(data.usage?.input_tokens || 0);
    totalOut += Number(data.usage?.output_tokens || 0);
    lfGen?.end({
      output: data.output,
      usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens, unit: 'TOKENS' },
    });

    const output: any[] = Array.isArray(data.output) ? data.output : [];
    const functionCalls = output.filter((o) => o?.type === 'function_call');

    // Did the model submit its final answer this turn? Enforce (once) that it
    // has read the chosen chapter's Section/Chapter Notes first — notes are
    // legally decisive and a frequent source of misclassification (e.g. a
    // fastener is a "part of general use" in Section XV, not a vehicle part).
    let notesRejection: { call_id: string; chapter: string } | null = null;
    for (const call of functionCalls) {
      if (call.name === 'submit_classification') {
        const parsed = safeParse<HtsClassifyResult>(call.arguments);
        // Require a non-empty code: never accept an empty/refusal submit (the
        // invalid-submit branch below asks the model to re-send a real code).
        if (parsed && parsed.hs_code && parsed.hs_code.trim()) {
          const chap = chapterOf(parsed.hs_code);
          if (!forcedSubmit && !notesEnforced && chap && !notesRead.has(chap)) {
            notesEnforced = true;
            notesRejection = { call_id: call.call_id, chapter: chap };
          } else {
            result = parsed;
          }
        }
      }
    }
    if (result) {
      opts.onEvent?.({ type: 'done', detail: { rounds, hs_code: result.hs_code } });
      break;
    }

    if (functionCalls.length === 0) {
      // Model produced text but no tool call. Force a structured submit once.
      if (!forcedSubmit) {
        forcedSubmit = true;
        input = [
          {
            role: 'user',
            content:
              'Now finalize: call submit_classification with your best structured classification, even if confidence is Low.',
          },
        ];
        continue;
      }
      break; // already forced and still nothing — give up to the fallback
    }

    // Execute data tools; feed results back keyed by call_id.
    const outputs: any[] = [];
    for (const call of functionCalls) {
      if (call.name === 'submit_classification') {
        const msg =
          notesRejection && notesRejection.call_id === call.call_id
            ? `Before finalizing, you MUST consult the notes for Chapter ${notesRejection.chapter} (the chapter of your chosen code). Call get_notes("${notesRejection.chapter}") and confirm no Section or Chapter Note excludes this product from that chapter — pay particular attention to "parts of general use" (Section XV) and any parts/scope exclusions. Then call submit_classification again; your choice may stand or change.`
            : 'Your submit_classification arguments were not valid for the schema. Re-send one valid submit_classification call.';
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: msg });
        continue;
      }
      toolCalls++;
      const args = safeParse<Record<string, unknown>>(call.arguments) || {};
      // Record which chapters' notes the agent has actually read (gates submit).
      if (call.name === 'get_notes') {
        const c = chapterOf(String((args as { chapter?: string }).chapter ?? ''));
        if (c) notesRead.add(c);
      }
      opts.onEvent?.({ type: 'tool', detail: { name: call.name, args } });
      const lfSpan = lfTrace?.span({ name: call.name, input: args });
      let out: string;
      try {
        out = await runDataTool(call.name, args);
        lfSpan?.end({ output: out });
      } catch (e: any) {
        out = `Tool error: ${e?.message || String(e)}`;
        lfSpan?.end({ output: out, level: 'ERROR' });
      }
      trace.push({ tool: call.name, input: args, output: out });
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: out });
    }

    // Converge before the round budget runs out, so we return a real answer
    // instead of the empty fallback. Nudge as it gets close; force a submit on
    // the final round (tool_choice below pins submit_classification).
    const remaining = maxRounds - rounds;
    if (remaining <= 1) {
      forcedSubmit = true;
      outputs.push({
        role: 'user',
        content:
          'You are out of tool budget. Call submit_classification NOW with your single best code — never leave hs_code empty. If unsure, submit your best candidate with confidence "Low" and needs_human_review=true. Do not call any other tool.',
      });
    } else if (remaining <= 3) {
      outputs.push({
        role: 'user',
        content: `Only ${remaining} tool rounds remain. Converge now: if you already have a defensible heading, read its notes (if you haven't), drill to the 8/10-digit line with expand_code, and submit_classification. Avoid further broad searches.`,
      });
    }

    input = outputs;
  }

  if (!result) {
    result = fallbackResult(
      productText,
      rounds >= maxRounds ? `reached the ${maxRounds}-round limit` : 'no structured answer was produced',
    );
  }

  // Ground the code against the DB (free; fills authoritative duties, catches
  // hallucinated suffixes), then optionally run the adversarial verifier.
  await applyGrounding(result);

  let verified = false;
  const doVerify = opts.verify ?? process.env.HTS_VERIFY === 'true';
  if (doVerify && result.hs_code) {
    const v = await verifyClassification(productText, result, { model, signal: opts.signal, lfTrace });
    if (v) {
      verified = true;
      totalIn += v.inTok;
      totalOut += v.outTok;
      if (v.verdict === 'revise' && v.revised_code.replace(/\D/g, '').length >= 6) {
        const original = result.hs_code;
        result.alternatives = [
          { code: original, reason: 'Original code before verification' },
          ...(result.alternatives || []),
        ].slice(0, 3);
        result.hs_code = v.revised_code;
        result.confidence = v.revised_confidence;
        result.needs_human_review = true;
        result.gri_path = result.gri_path
          ? `${result.gri_path} (verified/revised)`
          : 'verified/revised';
        result.notes = appendNote(result.notes, `[Verifier revised] ${v.critique}`);
        result.verification = { verdict: 'revise', revised_from: original, critique: v.critique };
        await applyGrounding(result); // re-ground duties for the revised code
        opts.onEvent?.({ type: 'verified', detail: { verdict: 'revise', hs_code: result.hs_code } });
      } else {
        result.verification = { verdict: 'confirm', critique: v.critique };
        opts.onEvent?.({ type: 'verified', detail: { verdict: 'confirm' } });
      }
    }
  }

  // Calibrate confidence from objective signals (grounding, verifier, CROSS
  // agreement, ambiguity) — deterministic and free. Overrides the model's
  // self-reported confidence, which is poorly calibrated.
  if (result.hs_code) {
    const cal = calibrateConfidence(result);
    result.confidence = cal.confidence;
    result.confidence_pct = cal.confidence_pct;
    result.needs_human_review = cal.needs_human_review;
    result.calibration = { signals: cal.signals };
  }

  const cost = estimateCost(model, totalIn, totalOut);

  // Finalize the trace: the output the UI shows for this run, plus a
  // deterministic score computed from the SAME calibration signals used for
  // needs_human_review — this is what shows up as an "eval" on the trace in
  // Langfuse without needing a labeled dataset (score fully offline/free).
  if (lfTrace) {
    lfTrace.update({ output: result, metadata: { rounds, toolCalls, cost } });
    if (result.hs_code) {
      lfTrace.score({
        name: 'calibrated_confidence_pct',
        value: result.confidence_pct,
        comment: (result.calibration?.signals || []).join('; '),
      });
      lfTrace.score({ name: 'code_valid', value: result.code_valid ? 1 : 0 });
    }
    // Queued events are batched by the SDK; flush so a short-lived script
    // (the README example, a one-off CLI call, `hts:eval`) doesn't exit before
    // they're sent.
    await flushLangfuse();
  }

  return {
    result,
    usage: {
      processingTime: Date.now() - startTime,
      cost,
      totalTokens: totalIn + totalOut,
      toolCalls,
      rounds,
      model,
      verified,
      traceId: lfTrace?.id,
    },
    trace,
  };
}

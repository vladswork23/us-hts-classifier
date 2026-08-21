import type { HtsClassifyResult } from './types';
import { runDataTool } from './tools';
import type { LangfuseTraceClient } from 'langfuse';

/**
 * Adversarial second-pass verifier. After the agent proposes a classification,
 * this runs ONE structured LLM call (no tools) that re-checks the code against
 * the heading text, the Section/Chapter Notes (fed in), specificity (GRI 3a),
 * and the statistical suffix — and either confirms it or proposes a correction.
 *
 * Opt-in (HTS_VERIFY / opts.verify) because it adds an LLM call per
 * classification. Provider: OpenAI Responses API via raw fetch, matching
 * classify.ts (keeps the agent provider-consistent and avoids the openai SDK).
 */

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const VERIFY_PROMPT = `You are an adversarial senior US customs auditor reviewing a junior classifier's proposed HTS code. Your job is to CATCH ERRORS, not rubber-stamp. Check in order:
1. Heading text — do the terms of the proposed heading actually cover this product?
2. Section/Chapter Notes (provided below) — does any note EXCLUDE this product from the chapter or redirect it elsewhere? (e.g. "parts of general use" belong in Section XV by their own heading, not as parts of a machine/vehicle; watch for explicit exclusions.)
3. Specificity (GRI 3a) — is there a clearly MORE SPECIFIC heading/subheading that fits better?
4. The 8/10-digit line — is the chosen subheading and statistical suffix plausible for this exact product?

Respond "confirm" if the code is defensible. Respond "revise" ONLY when you are confident it is wrong; then put the corrected full US HTS code (10 digits where possible) in revised_code. Cite the deciding note or heading in critique (1-3 sentences). Do not revise on mere preference.`;

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['confirm', 'revise'] },
    revised_code: {
      type: 'string',
      description: 'If verdict is "revise", the corrected full HTS code; otherwise "".',
    },
    revised_confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    critique: { type: 'string', description: 'The specific deciding reason (1-3 sentences).' },
  },
  required: ['verdict', 'revised_code', 'revised_confidence', 'critique'],
} as const;

export interface VerifyVerdict {
  verdict: 'confirm' | 'revise';
  revised_code: string;
  revised_confidence: 'High' | 'Medium' | 'Low';
  critique: string;
  inTok: number;
  outTok: number;
}

function extractText(data: any): string {
  const out = Array.isArray(data?.output) ? data.output : [];
  for (const item of out) {
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
      }
    }
  }
  return typeof data?.output_text === 'string' ? data.output_text : '';
}

export async function verifyClassification(
  product: string,
  result: HtsClassifyResult,
  opts: { model: string; signal?: AbortSignal; lfTrace?: LangfuseTraceClient },
): Promise<VerifyVerdict | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !result.hs_code) return null;

  const chapter = result.hs_code.replace(/\D/g, '').slice(0, 2);
  let notes = '';
  try {
    notes = await runDataTool('get_notes', { chapter });
  } catch {
    notes = '(notes unavailable)';
  }

  const userContent =
    `PRODUCT: ${product}\n\n` +
    `PROPOSED CLASSIFICATION:\n` +
    `- code: ${result.hs_code}\n` +
    `- hierarchy: ${JSON.stringify(result.hierarchy)}\n` +
    `- reasoning: ${result.reasoning}\n\n` +
    `SECTION/CHAPTER NOTES for chapter ${chapter}:\n${notes.slice(0, 6000)}\n\n` +
    `Review the proposed code per your checklist.`;

  const body = {
    model: opts.model,
    instructions: VERIFY_PROMPT,
    input: [{ role: 'user', content: userContent }],
    reasoning: { effort: 'medium' },
    max_output_tokens: 4000,
    text: { format: { type: 'json_schema', name: 'verify', strict: true, schema: VERIFY_SCHEMA } },
  };

  const lfGen = opts.lfTrace?.generation({
    name: 'verify',
    model: opts.model,
    input: [{ role: 'system', content: VERIFY_PROMPT }, { role: 'user', content: userContent }],
  });

  let data: any;
  try {
    const resp = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(120000),
    });
    if (!resp.ok) {
      lfGen?.end({ level: 'ERROR', statusMessage: `HTTP ${resp.status}` });
      return null; // verification is best-effort; never block the answer
    }
    data = await resp.json();
  } catch (e: any) {
    lfGen?.end({ level: 'ERROR', statusMessage: e?.message || String(e) });
    return null;
  }

  const raw = extractText(data);
  let parsed: Omit<VerifyVerdict, 'inTok' | 'outTok'> | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || (parsed.verdict !== 'confirm' && parsed.verdict !== 'revise')) {
    lfGen?.end({ output: raw, level: 'WARNING', statusMessage: 'unparseable verifier output' });
    return null;
  }

  lfGen?.end({
    output: parsed,
    usage: { input: data?.usage?.input_tokens, output: data?.usage?.output_tokens, unit: 'TOKENS' },
  });

  return {
    verdict: parsed.verdict,
    revised_code: parsed.revised_code || '',
    revised_confidence: parsed.revised_confidence || result.confidence,
    critique: parsed.critique || '',
    inTok: Number(data?.usage?.input_tokens || 0),
    outTok: Number(data?.usage?.output_tokens || 0),
  };
}

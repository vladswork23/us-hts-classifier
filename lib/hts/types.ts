/**
 * Shared types for the US-HTS classifier agent. Provider-agnostic — these
 * describe the agent's structured output and internal tool shapes, not any
 * specific LLM API.
 */

/** The agent's final structured classification (mirrors RESULT_SCHEMA in prompt.ts). */
export interface HtsClassifyResult {
  /** Best US HTS code, 10 digits when determinable (e.g. "6109.10.00.04"). */
  hs_code: string;
  /** Short normalized product description. */
  product: string;
  confidence: 'High' | 'Medium' | 'Low';
  confidence_pct: number;
  /** Which GRI rules were applied, in order, e.g. "GRI 1 -> GRI 6". */
  gri_path: string;
  /** Why this code fits, citing GRI logic, notes, and key product facts. */
  reasoning: string;
  hierarchy: {
    section: string;
    chapter: string;
    heading: string;
    subheading: string;
  };
  alternatives: Array<{ code: string; reason: string }>;
  /** CBP CROSS rulings that support the choice. */
  supporting_rulings: Array<{ ruling: string; code: string; note: string }>;
  /** Chapter 99 / Section 301 / 232 additional duty codes that may overlay, or "". */
  ch99_overlay: string;
  /** General (Column 1) duty rate for the chosen code, or "". */
  duty_general: string;
  /** Special / FTA preferential rates, or "". */
  fta_special: string;
  /** Ambiguities or facts that could change the code. */
  notes: string;
  needs_clarification: boolean;
  clarifying_question: string;
  /** True when confidence is low / inputs are thin and a human should confirm. */
  needs_human_review: boolean;

  // --- Fields set AFTER the model returns (not part of RESULT_SCHEMA) ---
  /** Set by the DB grounding step: did hs_code resolve to a real current HTS line? */
  code_valid?: boolean;
  /** Set by the optional second-pass verifier. */
  verification?: {
    verdict: 'confirm' | 'revise';
    /** Original code, when the verifier revised it. */
    revised_from?: string;
    critique: string;
  };
  /** Set by the deterministic confidence calibration step (the reasons it moved). */
  calibration?: { signals: string[] };
}

export interface ClassifyUsage {
  processingTime: number;
  cost: number;
  totalTokens: number;
  toolCalls: number;
  rounds: number;
  model: string;
  /** Whether the optional second-pass verifier ran. */
  verified: boolean;
}

export interface ClassifyOptions {
  /** Override the model id (default: HTS_MODEL env or "gpt-5-mini"). */
  model?: string;
  /** Max agentic tool-call rounds before forcing a final answer (default 12). */
  maxRounds?: number;
  /** Progress callback (tool calls, rounds) — used by the eval harness / UI. */
  onEvent?: (e: { type: string; detail?: Record<string, unknown> }) => void;
  /** Abort signal for the whole classification. */
  signal?: AbortSignal;
  /**
   * Run the adversarial second-pass verifier after the agent answers. Defaults
   * to the HTS_VERIFY env flag (off unless "true") so eval runs don't add cost
   * unless explicitly enabled.
   */
  verify?: boolean;
}

export interface ClassifyTraceEntry {
  tool: string;
  input: unknown;
  output: string;
}

export interface ClassifyOutcome {
  result: HtsClassifyResult;
  usage: ClassifyUsage;
  trace: ClassifyTraceEntry[];
}

/** A single function tool in the OpenAI Responses API "flat" shape. */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

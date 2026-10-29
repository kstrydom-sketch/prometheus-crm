import { GoogleGenAI } from '@google/genai'

// Reads a signed client contract (SOW) into the three things the team needs on
// hand: what we owe, what revisions we promised, and anything unusual. The
// result only pre-fills a form; a person reviews and saves it.

const MODEL = 'gemini-2.5-flash'
// Inline request ceiling. Signed SOWs are a few hundred KB.
export const MAX_CONTRACT_AI_BYTES = 18 * 1024 * 1024

export type ContractRead = { title: string; signed_on: string; deliverables: string; revisions: string; special_terms: string }

const S = { type: 'string' } as const
const schema = {
  type: 'object',
  properties: { title: S, signed_on: S, deliverables: S, revisions: S, special_terms: S },
  required: ['title', 'signed_on', 'deliverables', 'revisions', 'special_terms'],
  propertyOrdering: ['title', 'signed_on', 'deliverables', 'revisions', 'special_terms'],
}

const PROMPT = `You are reading a signed agency contract or statement of work (SOW) for an operations coordinator. Extract only what the document says. Never infer, never fill gaps from what contracts usually say.

Return:
- title: a short name for the agreement, e.g. "Marketing Moments + BFCM SOW, Oct 2026".
- signed_on: the effective date, or the signature date if there is no effective date, as YYYY-MM-DD. "" if neither is stated.
- deliverables: every deliverable with its exact quantity and cadence, one per line, grouped by service, e.g. "BFCM: 300 ads (240 static: 80 text-only, 30 refreshed top performers, 130 new; 60 motion: 20 refreshed, 40 motion graphics)". Include fees per service on its line when stated.
- revisions: the revision terms per deliverable type, one per line, quoting the rule exactly as written (rounds, approval windows, "no revisions"). If a service has no revision clause, say so explicitly, e.g. "BFCM ads: no revision clause in this contract". "" only if the document has no revision terms at all.
- special_terms: only terms that change how we work or get paid: term length and renewal or opt-out mechanics, notice periods, discounts, deadlines or launch dates, change-request cutoffs, rollover rules, exclusivity, anything unusual. One per line. Skip generic legal boilerplate.

Plain text, short lines, no markdown symbols.`

export async function readContractWithGemini(pdf: Buffer, mimeType: 'application/pdf' | 'text/plain'): Promise<ContractRead> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.')
  const res = await new GoogleGenAI({ apiKey }).models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: pdf.toString('base64') } }, { text: PROMPT }] }],
    config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
  })
  const parsed = JSON.parse(res.text ?? '{}') as Partial<ContractRead>
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '').slice(0, max)
  const date = text(parsed.signed_on, 10)
  return {
    title: text(parsed.title, 200),
    signed_on: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    deliverables: text(parsed.deliverables, 5000),
    revisions: text(parsed.revisions, 2000),
    special_terms: text(parsed.special_terms, 5000),
  }
}

// Serverless proxy to Groq's OpenAI-compatible chat completions endpoint.
// The API key lives only in the GROQ_API_KEY environment variable on the host.
// It is never sent to the browser and is never committed to git.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_BODY_BYTES = 50 * 1024;   // reject anything larger
const MAX_TOKENS = 600;             // hard cap, whatever the client asks for
const RATE_WINDOW_MS = 60_000;      // per-IP sliding window
const RATE_MAX = 30;                // requests per window per IP (one full conversation is ~8)
const ALLOWED_MODELS = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
]);
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

// Best-effort in-memory limiter. Serverless instances are recycled and there may
// be several at once, so this throttles abuse rather than enforcing an exact quota.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WINDOW_MS)) hits.delete(k);
  return recent.length > RATE_MAX;
}

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
const fail = (status, message, extra) => json(status, { error: { message } }, extra);

export default async (req, context) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed. Use POST.');

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fail(500, 'The server is missing GROQ_API_KEY. Set it in the site environment variables.');

  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) return fail(429, 'Too many requests. Wait a minute and try again.', { 'retry-after': '60' });

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return fail(413, 'Request body too large (limit 50 KB).');

  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, 'Body must be valid JSON.'); }
  if (!Array.isArray(body.messages) || !body.messages.length) return fail(400, 'messages must be a non-empty array.');

  const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const payload = {
    model,
    messages: body.messages,
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
    // gpt-oss is a reasoning model. Left to its defaults it leaks successive drafts of
    // the same answer into content, glued together without spacing, and drifts language.
    // Hiding the reasoning channel and keeping effort low removed that in testing.
    reasoning_format: body.reasoning_format || 'hidden',
    reasoning_effort: body.reasoning_effort || 'low',
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = body.tool_choice || 'auto';
  }

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return fail(502, 'Could not reach the model provider: ' + err.message);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the provider's status through, but never its headers (they can echo auth state).
    let message = `Model provider returned ${upstream.status}.`;
    try { message = JSON.parse(text)?.error?.message || message; } catch {}
    return fail(upstream.status, message);
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

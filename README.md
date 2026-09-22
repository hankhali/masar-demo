# Masar — shipment assistant prototype

**Live demo: https://masar-shipment-demo.netlify.app**

A working prototype of a customer-facing shipment assistant for a UAE postal and
courier operator, built for a job assessment. A customer can track a parcel,
rebook a missed delivery, or correct a delivery address, in English or Arabic.
Everything the agent does is printed as a receipt in the operations console next
to the chat, so you can see each lookup, each policy check and each write.

## What it runs on

The whole demo is one self-contained page. The shipment data is the **provided
assessment dataset**, cleaned and embedded directly in `index.html`, and the
**backend is mocked in the browser** — there is no real courier system behind it.
Writes (rebooking a slot, changing an address) are committed to that in-memory
mock and shown as a diff on the shipment record. **Reset data** restores the
original dataset.

The demo clock is pinned to **Wed 26 Aug 2026**, the day after the latest event
in the dataset.

## Architecture

The point of the prototype is the split between what acts and what is allowed:

- **Tools act.** Seven tools do all the real work: `lookup_shipment`,
  `verify_customer`, `get_delivery_slots`, `reschedule_delivery`,
  `validate_address`, `update_address`, `create_handoff`. Every fact shown to a
  customer comes from a tool call. Nothing is improvised.
- **A policy guard in code decides.** Before any tool returns data or commits a
  change, a set of rules written in plain JavaScript is evaluated —
  identity (`P-ID-*`), privacy (`P-PR-*`), data quality (`P-DQ-*`),
  rescheduling (`P-RS-*`), address change (`P-AD-*`), writes (`P-WR-*`),
  handoff (`P-HO-*`). Each rule stamps the trace green when it passes and red
  when it blocks. **The planner never has the final say.** Unverified callers get
  a status-only view; nothing is written until the customer says yes; conflicting
  records and exhausted attempts go to a human. See the **Policies** tab for the
  full table, including which rules are assumptions and which come from the data.
- **Two interchangeable planners** sit in front of the same tools and the same
  guard:
  - **Rules engine** (default) — a deterministic intent parser. Offline, no
    network, never fails in a demo.
  - **LLM mode** — a live model plans the conversation and calls the same tools.
    The policy checks are identical; switching planners cannot widen what the
    agent is permitted to do.

The **Data quality** tab reports what was wrong in the source export and how each
issue is handled. The **Value case** tab is a cost model whose inputs are all
adjustable, because the operator's real call volume and cost per call are unknown.

## LLM mode

LLM mode talks to **Groq** (OpenAI-compatible chat completions,
`openai/gpt-oss-120b`) through a small serverless function at `/api/chat`
(`netlify/functions/chat.js`).

The API key lives only in the `GROQ_API_KEY` environment variable on the host.
**It is never shipped to the browser and never committed to this repo.** The
function also caps `max_tokens` at 600, rejects request bodies over 50 KB,
restricts which models may be requested, and applies a per-IP rate limit.

If the model is unreachable, the page says so and falls back to the rules engine
for that message, so the demo never dead-ends.

## Running it locally

**For the rules engine — just open `index.html` in a browser.** No build step, no
server, no dependencies. That covers every scenario in the list.

LLM mode additionally needs the serverless function, so it needs a local server:

```bash
npm i -g netlify-cli
export GROQ_API_KEY=your_groq_key   # free key from https://console.groq.com
netlify dev
```

Opening `index.html` as a file will leave LLM mode unable to reach `/api/chat`;
the page will fall back to the rules engine, which is expected.

## Try it

Open **Try a scenario from the dataset** under the chat. Each scenario is a real
shipment from the export, picked to exercise a different rule — a missed delivery,
an unusable address on file, contradictory records, an Arabic-speaking customer,
a parcel that has used all three attempts, an off-topic request. The system line
above the chat tells you the last 4 digits to verify with.

## Caveats

This is a prototype for discussion, not production code. The backend is mocked,
the dataset is small, the SLAs and several policy thresholds are assumptions
marked as such in the Policies tab, and in production the model would be called
from a server with proper auth, logging and abuse controls rather than from a
demo function.

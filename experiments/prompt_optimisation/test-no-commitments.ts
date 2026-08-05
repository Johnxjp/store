// Checks the winning prompt against a short discussion-only transcript:
// notes must NOT contain a "Next steps" section when no one committed to
// anything. Usage: npx tsx experiments/prompt_optimisation/test-no-commitments.ts <variant>
import { variants } from './prompts'

const OLLAMA_URL = 'http://localhost:11434/api/chat'
const MODEL = process.env.MODEL ?? 'qwen2.5:14b'

const name = process.argv[2] ?? 'v8'
const variant = variants.find((v) => v.name === name)
if (!variant) throw new Error(`unknown variant: ${name}`)

const user = [
  'Meeting: Architecture chat',
  'Date: 5 August 2026',
  '',
  '### Transcript',
  '[00:00] Me: I read that post about moving the cache layer to Redis. Curious what you think.',
  "[00:09] Them: Honestly, I think our Postgres materialized views are fine at our scale. Redis adds an operational dependency and we'd need to solve invalidation twice.",
  '[00:24] Me: That was my instinct too. The post assumed a hundred times our traffic.',
  "[00:33] Them: Right. If we ever see cache misses dominating the p99, that's the signal to revisit. For now the numbers look healthy — reads are around four milliseconds.",
  '[00:48] Me: Makes sense. Interesting discussion anyway, it clarified how the invalidation actually works today.',
  '[00:57] Them: Yeah, I enjoyed it. Nice chatting.'
].join('\n')

console.error(`[${name}] no-commitments check against ${MODEL}...`)
const res = await fetch(OLLAMA_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    options: variant.options,
    messages: [
      { role: 'system', content: variant.system },
      { role: 'user', content: user }
    ]
  })
})
if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
const data = (await res.json()) as { message?: { content?: string } }
const content = data.message?.content?.trim() ?? ''
console.log(content)
console.error(
  /next steps/i.test(content)
    ? '\nFAIL: output contains a Next steps section'
    : '\nPASS: no Next steps section'
)

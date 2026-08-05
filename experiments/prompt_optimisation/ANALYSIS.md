# Summary prompt optimisation

How the production summary prompt (v11, in `src/main/enhance.ts`) was
developed. The test transcripts, fact checklists, and generated outputs are
real meetings, so they are local-only and gitignored — only the method and
lessons are recorded here.

## The problem

Our enhanced notes for a real job-interview meeting were far worse than
Granola's for the same meeting: bare topic labels with no detail, a "no
decisions were made" filler section, and the closing action item attributed
to the wrong person. Two root causes:

1. **Silent context truncation.** The production Ollama call set no
   `num_ctx`, so the ~16k-token transcript was truncated to Ollama's
   4096-token default before the model ever saw most of it.
2. **The prompt asked for the wrong thing** — literally "a list of key
   topics covered", which is what it got.

## Method

- Harness: `run.ts` runs any set of prompt variants (`prompts.ts`) against
  the test transcripts via Ollama and writes each output to `outputs/` for
  side-by-side comparison. Temperature 0 so reruns are comparable.
- Scoring: a hand-built checklist of 16 facts per meeting, verified against
  the transcript — concrete numbers, named systems, specific stories, and
  the closing commitments. Count facts present *and correct*; an attribution
  error counts as wrong even if the fact appears.
- Two test meetings with different shapes (a hiring-manager interview and a
  recruiter screen) so a prompt change that helps one can be checked for
  regressions on the other.

## What the iterations taught (v0 → v11)

- The baseline (truncated context + topic-list prompt) scored ~2/16.
  Fixing `num_ctx` and rewriting the prompt around substance-under-headings
  jumped to ~8/16; concreteness guidance ("every number, name, and example
  belongs") got past 10/16.
- **Attribution needs an explicit rule.** Models default to voicing
  commitments as the note-taker's. The fix that stuck: the owner is the
  speaker of the sentence that made the commitment.
- **Bans cause collateral damage.** "Skip the goodbyes" deleted a real
  action item spoken during the goodbyes; the fix was pairing every
  exclusion with its exception (commitments made while wrapping up still
  count). Similarly, "purpose decides relevance" removed small talk more
  reliably than enumerating banned topics.
- **Overview-first works.** Asking the model to state the meeting's core
  purpose up front, then letting relevance to that purpose filter the rest,
  fixed both padding and filler sections. But asking the overview to also
  cover participants pushed name fabrication — keep the overview ask small.
- **At 14B, prompt edits are non-local.** One added sentence repeatedly
  regressed unrelated behaviour. Never reword the production prompt without
  re-running this harness.

v11 shipped alongside `num_ctx: 32768`, `temperature: 0`, and a
`maxTranscriptChars` cap matched to the real context window.

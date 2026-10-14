# AI tools

Built-in tools are explicitly referenced in published instructions using
`[[tool:handoff]]`, `[[tool:record]]`, `[[tool:skip]]`, `[[tool:search]]`, or
`[[tool:send_media]]`. The authorized instruction catalog returns their labels
and descriptions beside the existing variable catalog. Tool arguments are
strictly validated; assignment targets and arbitrary media URLs are not accepted.
A model response can request at most three actions. Handoff, skip and media send
are terminal and must be the final action.

## Durable execution

Migration `0050_ai_tool_actions.sql` adds an additive action ledger. A logical
operation and ordinal identify one stable action. Each action records its Member,
definition revision, arguments, state and result separately from provider attempts
and customer messages. Successful actions are reused on recovery.

Execution claims the action in a short transaction, then executes after that
transaction ends. Database effects and their successful receipts commit together
in a second short transaction. Both boundaries use the existing response commit
authorization: current ownership, customer input, channel access, stop/handoff
rules, variable provenance, memory and proactive-event eligibility. Ordinary
replies also require the tool in both frozen and current published instructions.
Removing authorization cancels pending execution; it does not undo an already
committed effect. No network call occurs inside these transactions.

- `handoff` uses the assignment boundary and preserves assignment history and
  `HUMAN_ONLY`. Its post-commit publishing uses the existing handoff adapter.
- `record` creates an internal note with the AI Member as author. The note is not
  an outbound message or a grounding source.
- `skip` marks only the current run `SKIPPED`, with `TOOL_SKIP`; conversation
  lifecycle and ownership remain unchanged.
- `send_media` commits an authorized retrieved private asset through the existing
  response boundary. Grounding checks require its cited knowledge reference;
  delivery remains independent after a valid message commit.

This runtime slice covers these four database actions. Search result consumption,
sandbox action simulation, instruction selection and action diagnostics are
subsequent acceptance slices of the same feature. External tools and ordered
skills are separate stages and are not enabled by this slice.

## Operations

Apply migration 0050 before deploying this runtime. Application deployment does
not apply database migrations. The migration creates one table and indexes; it
does not rewrite conversation or message data. Production migration and live
provider verification remain separate operator steps.

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

- `search` retrieves only the frozen configuration's knowledge base. Results enter
  one final, tool-disabled generation as quoted knowledge chunks, preserving
  normal grounding. A successful search stores IDs, then rereads canonical
  authorized content on reuse and before final response commit. Tool-specific
  provider stages share the original logical operation and charge; follow-up
  generation cannot open a new action plan or exceed the three-call limit.

The instruction editor exposes the authorized tool picker beside variables.
The test bench simulates all write actions and persists distinct simulated
receipts; it never assigns a real conversation, creates a real note or sends
customer messages. Clearing a test prevents late results and actions from
appearing in the new generation. Search in tests still uses authorized knowledge
and final grounding.

Diagnostics expose stable call IDs, labels, revision, simulated/live state and
failure state. They omit action arguments and result payloads, including note
text and variable values. Live diagnostic details and run lists require the
requesting Member and AI to retain the source channel grant, including for
administrators. This diagnostic rule does not change existing inbox role rules.
Tests remain under existing manager/workspace authorization.

Sandbox search is an actual authorized read: it durably claims a stable search
action before retrieval/provider I/O. Completion and cached-result reuse recheck
the current requesting user's permission and test generation, then reread
canonical knowledge. Clearing cancels unfinished search receipts without erasing
provider attempts or cost. Failed and unknown reads retain explicit action states;
pure simulated writes need no separate execution process.

Known provider-unknown outcomes mark pending actions `UNKNOWN`; safe provider
backoff retains a recoverable claim. Permanent failures mark pending actions
`FAILED`. Completed receipts are preserved when a later generation fails.
External tools and ordered skills are separate stages and are not enabled by
this built-in tools stage.

## Operations

Apply migration 0050 before deploying this runtime. Application deployment does
not apply database migrations. The migration creates one table and indexes; it
does not rewrite conversation or message data. Production migration and live
provider verification remain separate operator steps.

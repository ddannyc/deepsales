# AI setup guidance and persona drafts (T21)

The AI member page checks instructions and reply language, saved knowledge readiness,
active channel grants, provider configuration and member status. These checks guide setup;
they do not change existing publishing requirements. Refreshing them preserves local edits.

Generate and optimize return a private, editable candidate. They use only the supplied brief
and existing instructions, without customer history or knowledge retrieval. Candidates are
recorded in the existing AI operation ledger and never change saved or published settings.
Adopting a candidate changes only local instructions. Saving, testing and publishing remain
separate explicit actions through the existing controls.

Briefs allow 2,000 characters; source instructions and final candidates allow 20,000.
Provider output reserves space for mandatory knowledge, authorization and general handoff
instructions. Invalid output fails without changing configuration. Existing quota, provider
attempt and idempotency rules apply to PERSONA operations. Canceling discards the preview
and late results, but does not undo an already started provider charge.

Migration 0039 extends the operation kind constraint. Apply it separately before deploying
the application; it does not alter existing operation data. Route tests use real PostgreSQL
and fake providers. Browser coverage verifies comparison, editing, cancellation, preservation
of other local fields, saving, testing and explicit publication. Real model drafting quality
requires separate acceptance. T22 remains a later slice of issue #37.

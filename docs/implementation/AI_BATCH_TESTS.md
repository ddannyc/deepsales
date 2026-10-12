# AI batch question tests (T22)

Managers maintain workspace- and member-scoped neutral question sets of 1–100
questions, up to 8,000 characters each. Updates require the current revision.
Deleting a question set preserves existing batches and results.

Creating a batch freezes its questions and saved draft, published or historical
main configuration. Each question has independent context. Knowledge and independent
handoff rules remain current resources; completion rechecks authorization and rule
revisions. No customer, conversation, assignment, message or production write tool
is created or invoked. There is no automatic scoring.

The browser executes questions serially through explicit authenticated requests.
Closing or refreshing the page stops further scheduling; stored batches can be
selected and resumed. PostgreSQL locks and a partial unique index allow at most one
running question per batch. Each question keeps one operation ID and logical charge,
while provider attempts and actual costs remain separate. Failed questions can be
retried independently, up to three executions with at least 30/120 seconds between
attempts and any longer provider retry-after. Invalid retrieval output is regenerated
on a new execution. Successful provider responses are reused when recovering the
same interrupted execution.

A running claim can be recovered after 60 seconds. An in-flight or unknown provider
result is never blindly retried: UNKNOWN pauses the entire batch. Canceling marks
unstarted questions as canceled. Already started questions may finish in their
original batch and still count toward usage; late browser responses cannot overwrite
a newly selected batch. A new batch has new question operation IDs.

Answers, retrieved evidence, configuration version, failure/cancellation status and
logical usage are available per question, with the existing diagnostic viewer for
full references and attempts. Batch selection lists the most recent 50 batches;
an existing batch ID remains retrievable through its authorized endpoint.

Apply migration 0040 separately before application deployment. It adds question sets,
batches and item state tables; existing production data is unchanged. Acceptance uses
real PostgreSQL routes and Playwright with fake providers. Real-model quality and
actual service costs require separate acceptance.

# AI property collection (T48)

Collection rules are independent member resources. Creating, editing, enabling,
disabling or deleting a rule takes effect immediately and does not publish or
restore main AI configuration. Each member can select up to 20 existing customer
or conversation definitions with text, number or predefined option types.

The existing reply generation returns optional typed property values in the same
model call. The server derives customer and conversation targets; the model cannot
choose targets, create definitions, clear values or write arbitrary fields. Invalid
IDs, extra target fields, duplicate definitions and mismatched types are rejected.

Claims freeze rule/definition revisions, identity and value revisions. Before
commit PostgreSQL rechecks current ownership, input, channels and current rules.
Changed rules, definitions or identity cancel the stale reply and schedule a new
run. Human changes or protected values skip only the affected collection write.
Existing fields allow AI updates only when explicitly permitted; a newly collected
AI value remains eligible for later collection. Value and provenance history are
written in the same short transaction as the authorized reply, without external
calls. No collection occurs on pre-model stops or handoff-only outcomes.

Customer fields require access to every associated identity and contributing
value/history channel; conversation fields require their current and contributing
channels. Restricted fields are excluded entirely from the collection whitelist.
Collection data is separate from customer memory and company knowledge grounding.

Single and batch tests freeze the same rules and validate changes before storing
results. Session collection updates only simulated properties; test reset rejects
late results. Failed batch retries refresh their independent-rule context while
retaining the frozen main configuration and existing logical usage charge.

Apply forward migration 0044 before deploying. It adds independent rule storage,
the run input snapshot and a cancellation reason, without enabling any collection
or invoking models during migration. Production/model quality acceptance remains
separate from the PostgreSQL, substituted-provider and browser tests.

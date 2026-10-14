# Ordered AI skills

Skills are part of the main AI configuration: an ordered JSON array of stable
IDs, names, natural-language conditions and execution instructions. Saving edits
the draft. Publishing freezes the complete array and order in the existing
immutable configuration version. Restoring a historical version restores the
skills draft; it does not publish or roll back independent resources.

Migration `0051_ai_skills.sql` adds `ai_member_config.skills` with an empty-array
default. Existing versions without the field read as an empty array. Apply this
forward migration before deploying code that reads the new draft column.

The initial limits are 20 skills, 100 characters per name, 2,000 per condition,
8,000 per instruction and 20,000 Unicode code points across all conditions and
instructions. IDs must be unique. Variable and tool references use the existing
controlled catalogs; unknown references are rejected rather than silently ignored.

Each live or test turn classifies the frozen conditions without tool permission.
The provider may return multiple matching IDs; the server validates every ID and
selects the first in the frozen configuration order. Invalid or failed model
output uses the existing failure behavior. No match proceeds with the ordinary
grounded response. Handoff and stop policies retain priority.

The selected skill's ID, name and configuration version are persisted on the
existing operation before generating the answer. The final prompt and tool
authorization combine the main instructions with only that selected skill.
Unmatched skills cannot grant tools. Current published references, ownership,
input freshness and variable sources are rechecked at the existing commit/action
boundaries. Skill classification and response generation share the same logical
usage operation; tools retain the existing three-call limit and durable ledger.

The editor supports adding, removing and reordering skills. Changes use the main
draft save/publish controls. The multi-turn test bench and authorized diagnostics
show the selected skill; sandbox writes remain simulated. Historical snapshots
without skills continue to use ordinary replies.

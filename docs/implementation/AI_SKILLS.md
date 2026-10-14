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

This schema/configuration slice implements draft, publish and restore behavior.
Matching, execution and the editor are subsequent slices of the same stage.

# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `ddannyc/deepsales`. Use the `gh` CLI and pass `--repo ddannyc/deepsales` explicitly.

## Conventions

- Create an issue: `gh issue create --repo ddannyc/deepsales --title "..." --body-file <file>`.
- Read an issue and discussion: `gh issue view <number> --repo ddannyc/deepsales --comments`; fetch structured fields with `--json number,title,body,labels,comments` when needed.
- List issues: `gh issue list --repo ddannyc/deepsales --state open --json number,title,body,labels,comments`, filtered by the relevant label or state.
- Comment: `gh issue comment <number> --repo ddannyc/deepsales --body-file <file>`.
- Add or remove labels: `gh issue edit <number> --repo ddannyc/deepsales --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --repo ddannyc/deepsales`. Put a substantive closing explanation in a comment using `--body-file` first when needed.
- Preserve actual newlines with UTF-8 body files. Do not interpolate multiline bodies into shell command strings.
- Use the role mapping in `docs/agents/triage-labels.md`. Create missing labels without replacing unrelated existing labels.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares issue and PR numbers; resolve ambiguous references against the appropriate issue or PR command before modifying them.

## Skill operations

- “Publish to the issue tracker” means create a GitHub issue. Fully specified specs and tickets use `ready-for-agent` after required review is complete.
- “Fetch the relevant ticket” means read the issue body, labels, and relevant discussion.
- Check for an existing issue before creating another publication of the same spec or ticket.
- Self-contained tickets produced by `to-tickets` are already agent-ready and do not require another triage pass.

## Dependencies and wayfinding

- Use native GitHub sub-issues and blocking dependencies when available. A dependency identifies the blocker's numeric database ID, not its issue number or node ID.
- Add a dependency with `gh api --method POST repos/ddannyc/deepsales/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`; obtain that ID from the blocker issue API response.
- If native sub-issues or dependencies are unavailable, use a parent task list and explicit `Part of #<parent>` / `Blocked by: #<number>` references in issue bodies.
- A ticket is available only when every blocker is closed. Read dependencies and assignment before claiming it.
- Wayfinder maps use `wayfinder:map`; their decision tickets use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` as needed.
- Claim with `gh issue edit <number> --repo ddannyc/deepsales --add-assignee @me`. Record decisions in the issue discussion and update the parent map when resolving a decision ticket.

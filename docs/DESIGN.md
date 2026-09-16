# DeepSales Design System

This is the UI/UX contract for Lean V1. It defines the visual and interaction
rules for a professional support workspace; it is not a transcript of the
current rough UI.

## 1. Product UI principles

1. **Optimize for the next support action.** Make assignment, takeover, reply,
   handoff, and resolution easy to find and hard to misunderstand.
2. **Make durable state visible.** Show the state PostgreSQL and the provider
   actually know about. Do not imply success while work is pending or failed.
3. **Prefer density with legibility.** A support workspace is used repeatedly;
   compact rows and short paths are more valuable than decorative whitespace.
4. **Use one clear hierarchy.** Every screen has one primary task and one
   visually dominant action in each local context.
5. **Reveal complexity progressively.** Keep routine work visible and put rare,
   risky, or administrative actions in a contextual menu or dialog.
6. **Keep meaning consistent.** A state, action, color role, or control should
   behave and look the same wherever it appears.
7. **Design for recovery.** Loading, empty, permission, provider, and delivery
   failures explain what happened and what the user can do next.
8. **Accessibility is part of the design.** Keyboard use, focus, contrast,
   readable copy, and non-color status cues are required, not polish.

## 2. Product character

DeepSales should feel like a calm, capable customer-support workbench:
professional, compact, restrained, and trustworthy. The inbox is an operating
surface, not a dashboard or marketing page. Use quiet surfaces, clear dividers,
confident typography, and a limited accent color. Spend visual emphasis on
customer identity, conversation state, the next action, and delivery truth.

The authenticated product should use one neutral UI type family from the code
tokens. A distinctive brand treatment may appear in login or setup, but it
must not make the daily support workflow feel like a landing page.

## 3. Information density

- Optimize the authenticated shell for a desktop support workflow and repeated
  scanning. Most visible space should contain customer, conversation, status,
  or action information.
- Use modest page titles, compact list rows, short metadata, and predictable
  gutters. Do not create hero sections, oversized headings, decorative stats,
  or large empty bands in operational pages.
- Settings pages may group related controls, but a group is not automatically a
  card. Use spacing and dividers first; use a bordered surface only when it
  helps separate an independent task or state.
- Density must not reduce hit areas, text contrast, message readability, or
  touch/keyboard usability.

## 4. Application shell

- Use one global application navigation. Do not combine a global top navigation
  with a second global sidebar.
- On desktop, use a persistent left navigation or compact rail containing the
  DeepSales mark, workspace switcher, and the V1 destinations: Inbox, Team,
  Knowledge, and Facebook settings.
- The active destination uses a consistent combination of label/icon emphasis,
  a surface or edge indicator, and `aria-current="page"`. Do not rely on color
  alone.
- Keep the workspace and user area predictable: workspace switching near the
  brand, the signed-in user/role and sign-out in one utility area. Do not turn
  this area into a second navigation system.
- The content region owns the page title and page-local actions. A local header
  is appropriate; a second global navigation row is not.
- Top navigation is appropriate for authentication or setup when it helps
  orient the user. It is not appropriate as a duplicate of the authenticated
  application navigation.

## 5. Layout

- Use semantic layout tokens rather than page-specific widths. Standard pages
  use a readable centered container with consistent side gutters; the inbox is
  full-height and full-width within the shell.
- Use a regular content max width of roughly 1,100–1,200px unless the task is
  inherently wide. Keep at least 24px desktop gutters and 16px narrow-screen
  gutters.
- Use two columns only when both columns retain a useful minimum width. A
  narrow form plus an unreadable preview is not a valid split layout.
- The desktop inbox uses this functional structure:

  `global navigation | inbox views + conversation list | active conversation workspace`

  The inbox view selector may be a compact sub-rail inside the middle region;
  it is not another global navigation system. The conversation list should
  normally remain about 320–380px wide, with the thread receiving the remaining
  space and a usable minimum width.
- Long settings pages scroll as a page. The inbox keeps global navigation,
  inbox navigation/list, and thread scrolling independent so a long message
  history cannot hide the list or the composer.
- In the inbox, keep the conversation header available while reading, keep the
  composer available at the bottom of the thread, and let only the message
  history absorb the primary scroll.

## 6. Typography

Use semantic roles and code-backed type tokens, not arbitrary per-page sizes.

| Role | Use |
| --- | --- |
| Page title | One clear title for the current page; compact and readable, never a marketing hero in the app shell. |
| Section heading | A related group, list, or panel; visibly subordinate to the page title. |
| Body | Customer content, descriptions, and instructions; comfortable line height. |
| Secondary/meta | Channel, assignee, timestamps, counts, and supporting context; lower emphasis but still readable. |
| Label | Persistent form and control labels; sentence case and specific. |
| Dense list/table text | Compact identity, preview, state, and metadata rows; use truncation only where the full value is available in the detail view. |

Use sentence case for interface copy. Reserve uppercase or a utility/monospace
style for short machine states, compact metadata, or identifiers. Do not use
giant display type, extreme tracking, or a different heading scale on every
page.

## 7. Spacing

Use a 4px base rhythm with 8px as the common sub-unit. The preferred scale is
4, 8, 12, 16, 20, 24, 32, and 40px. Use the smallest value that preserves
clarity:

- 8–12px inside dense rows and control groups;
- 16–24px between related controls or sections;
- 24–32px between major regions;
- 32–40px for page-level separation.

Do not introduce one-off spacing values to repair one page. Add a token only
when the relationship is reusable.

## 8. Color semantics

Implementation tokens define the actual values. DESIGN.md defines their roles:

| Semantic role | Use |
| --- | --- |
| Background | Application canvas and low-emphasis page areas. |
| Foreground | Primary readable text and important controls. |
| Surface | Conversation, form, list, and content surfaces. |
| Muted | Secondary text, metadata, placeholders, and quiet dividers. |
| Border | Structural separation and control boundaries. |
| Primary/accent | The current primary action and selected/active emphasis. Use sparingly. |
| Success | Confirmed usable, sent, or completed state. |
| Warning | Attention required, constrained, processing, or potentially risky state. |
| Destructive | Failed, disabled by an error, deletion, closure, or irreversible action. |
| Informational | Neutral explanation, guidance, or in-progress context. |

Use semantic tokens in code. Do not hardcode arbitrary color literals in a
feature screen, invent page-specific status colors, or make status meaning
depend on hue alone.

## 9. Borders, radius, and elevation

- Use subtle 1px borders for pane boundaries, list separators, inputs, and
  meaningful group boundaries.
- Prefer surface changes and whitespace over borders around every section. A
  form, list row, or message does not become clearer merely because it is a
  card.
- Use a small shared radius for controls and occasional panels. Use pill shapes
  only for compact statuses or tags; buttons and pages should not be pills.
- Use elevation only for a dropdown, popover, dialog, or other layer that must
  separate from the page. Do not use shadows as decoration or on every card.
- Avoid gradients and ornamental background effects in the support workflow.

## 10. Icons

- Use one shared icon set and consistent sizing: approximately 16px for inline
  actions and 18–20px for primary navigation or prominent controls.
- An icon supports a label; it does not replace a label when the action is
  ambiguous. Icon-only controls require an accessible name and a tooltip when
  the meaning is not obvious.
- Provide visible focus for icon actions and do not use decorative icons to
  fill empty space. Status icons supplement the status text and never carry the
  only meaning.

## 11. Action hierarchy

- **Primary:** the one next action in the current context, such as Send,
  Take over, Save changes, or Publish.
- **Secondary:** useful but non-dominant actions, such as Refresh or Transfer.
- **Ghost:** low-risk navigation, filters, or utility actions that should not
  compete with the task.
- **Destructive:** Close, Disable, Delete, or actions with irreversible impact.
  Use the destructive treatment only for the action itself and confirm when
  appropriate.
- **Overflow:** infrequent or contextual actions such as Unassign, Close, or
  less common transfer options. Keep the primary next step visible.

Do not put several visually dominant buttons beside one another. Action labels
should use the same plain verb throughout a flow and describe the result of the
click.

## 12. Forms

- Keep labels visible and adjacent to their controls. A placeholder is an
  example, never the only label.
- Put concise descriptions below labels when a field affects routing,
  publishing, capacity, file limits, or another non-obvious behavior.
- Validate at the existing trust boundary and show a human-readable inline
  message near the relevant control. Preserve entered values where safe.
- Distinguish disabled because of permission, disabled because of current
  state, and loading because work is in progress. Explain a non-obvious
  disabled state.
- Preserve the action label while adding a busy indicator; prevent duplicate
  submits without making the control disappear.
- Give save and publish operations clear inline or toast confirmation. Draft
  state and published runtime state must remain visibly distinct.
- Use a confirmation dialog for destructive changes, capacity overrides, and
  actions that change ownership. State the consequence and name the confirm
  action precisely.

## 13. Status language

Use one semantic status treatment everywhere: a short text label, a consistent
visual marker, and an accessible text alternative. Never communicate a state by
color alone. Localized UI may translate the labels, but the underlying meaning
and severity must remain stable.

Fixed inbox views are query views, not conversation statuses. Preserve these
views and their meaning:

- My Conversations
- Waiting for Human
- AI Handling
- Unassigned
- All Open

Use the following canonical state vocabulary:

| Domain | States and meaning |
| --- | --- |
| Conversation lifecycle | `OPEN` and `CLOSED`; show lifecycle separately from assignment or inbox view. |
| Conversation handling | **AI Handling**, **Waiting for Human**, or **Unassigned**; an assigned human is identified by the member name. Do not expose `HUMAN_ONLY` as the primary user-facing label. |
| Delivery | `PENDING`, `SENT`, `FAILED`; `PENDING` is not success, and `FAILED` remains visible with a safe explanation. |
| Facebook | `ACTIVE`, `ACTION_REQUIRED`, `DISABLED`. |
| AI Member | `UNPUBLISHED`, `USABLE`, `UNHEALTHY`. |

Use the same semantic role and treatment on list rows, headers, settings, and
detail views. Include text and, where useful, an icon or shape. Do not invent a
new badge style for each page.

## 14. Lists and tables

- Make rows compact but scannable: identity first, preview or description next,
  metadata and state aligned predictably. A typical dense row is roughly
  52–64px, adjusted for wrapping content.
- Use a subtle hover state, a distinct selected state, and a visible keyboard
  focus state. Selection should have an edge or structural indicator as well as
  a surface change.
- Keep list dividers quiet. Do not wrap every row in a floating card.
- Show customer/member identity, the most useful preview, a compact timestamp,
  and assignment/status information without making the row a mini-dashboard.
- Empty states are scoped to the current list/filter and tell the user what
  will appear or what action creates the first item.

## 15. Menus, dialogs, and feedback

- Use a dropdown or contextual menu for secondary actions attached to a
  conversation, member, document, or channel.
- Use a dialog for destructive confirmation, ownership overrides, or decisions
  whose consequence cannot be inferred from the button label. Manage focus,
  Escape, and keyboard confirmation.
- Use a toast for short successful background actions or a completed save when
  the user does not need to make a decision. Keep important errors in the
  relevant page or component as inline feedback.
- Keep failed delivery next to the affected message; do not reduce it to a
  transient toast. Do not use browser `alert()` or `confirm()` as the product
  interaction.

## 16. Shared Inbox

The inbox is a work surface, not a dashboard/card layout. Preserve the five
product-defined views and use the desktop architecture below:

1. global application navigation;
2. inbox navigation and the conversation list;
3. the active conversation workspace.

### Conversation list

- Each row identifies the customer, channel when needed, latest message
  preview, compact relative timestamp, and current assignee or handling state.
- Keep rows short and information-dense. Use one or two preview lines and
  ellipsis only in the list; the thread contains the full message.
- Selected state must remain obvious without relying on color alone. If unread
  or attention data is supported, use a consistent weight/marker treatment and
  do not make every row visually urgent.
- Counts are optional query results. They must not be presented as a second
  status system.

### Conversation header

The header makes these facts discoverable without opening another screen:

- customer identity;
- channel;
- `OPEN`/`CLOSED` lifecycle;
- current assignee;
- AI or human handling state; and
- Messenger reply-window state.

Show the primary contextual action, usually Take over or the next permitted
reply action. Put Transfer, Unassign, Close, and other less frequent actions in
an overflow/contextual menu unless the current task makes one of them the clear
next step.

### Message thread

- Keep the readable message column roughly 600–720px wide and centered within
  the thread workspace. Customer and member messages may use moderate
  alignment or surface differences, but never sit at extreme opposite edges of
  a wide viewport.
- Identify the sender by context. AI messages use the AI member name and a
  clear AI marker; AI must not look like an unnamed human.
- Use compact human-readable times and group repeated timestamps. Make the
  exact timestamp available through a native time/tooltip or message details;
  do not print full `YYYY/MM/DD HH:mm:ss` on every message.
- Show `PENDING`, `SENT`, and `FAILED` in the message metadata using the shared
  status system. A failed message stays in the thread and is never silently
  replaced or presented as sent.
- Show AI generating as a live, non-message state in the header or thread. It
  must clear on every terminal path and must not masquerade as a committed
  customer-visible reply.
- Render inbound images as previews when ready. Render file, audio, and video
  as clearly labeled attachment rows with loading and failure states. Never
  expose provider URLs.
- Preserve long-message wrapping and readable line length. Do not truncate the
  thread content or force horizontal scrolling.

### Composer

- Keep the composer sticky at the bottom of the active thread, with a labeled
  textarea, Send action, and clear busy/sending state.
- Send is disabled when the user cannot reply, the reply window is closed, the
  text is empty, or a send is already in progress. The UI explains why it is
  disabled, especially for a closed Messenger window.
- Use `Enter` to send and `Shift+Enter` for a newline. The button remains
  available for keyboard and pointer users, and the behavior is announced by
  accessible help text where needed.
- Show a committed outbound message immediately as `PENDING`; do not wait for
  provider success to make the action visible. Prevent duplicate sends.
- When the selected conversation is not owned by the current human, provide a
  clear Take over affordance or explain why replying is unavailable.

### Scrolling

- Global navigation remains available while working.
- Inbox navigation and the conversation list scroll independently from the
  thread.
- The conversation header and composer remain usable while the message history
  scrolls.
- Realtime invalidation or polling may refresh data, but the UI must recover
  from canonical reads when a socket is lost.

## 17. Empty, loading, and error states

- Use structural skeletons for list/thread loading when the shape is known;
  avoid a page full of generic “loading” text.
- A no-conversations state names the current view and explains what will cause a
  conversation to appear. It does not display decorative widgets.
- A no-knowledge-documents state points to creating or uploading a document.
- Provider errors are inline, safe, and actionable: identify the affected
  channel/operation without exposing tokens, customer text, or raw provider
  errors.
- Failed message delivery remains in the thread with `FAILED` and a concise
  next step or safe failure reason.
- Permission and disabled states preserve readable context and explain the
  missing permission or current restriction. Do not silently hide the product
  behind an empty screen.

## 18. Responsive behavior

Desktop is the primary V1 support workflow. At narrower widths, collapse panes
intentionally rather than shrinking every pane until it becomes unusable:

- collapse global navigation to a labeled rail or menu;
- do not keep the inbox list and thread side by side below their usable minimum
  widths;
- on narrow screens, show one inbox region at a time, with an obvious back
  control from the thread to the list;
- keep the composer, status, and primary action accessible without horizontal
  scrolling; and
- change multi-column settings layouts to one column before fields become
  cramped.

## 19. Accessibility

- Every interactive control is keyboard reachable in a logical order. Dialogs
  trap focus appropriately, return focus on close, and support Escape.
- Use visible `:focus-visible` treatment with sufficient contrast. Do not remove
  the browser focus indication without a stronger replacement.
- Give buttons, links, inputs, menus, status regions, and icon-only actions
  accessible names. Use `aria-current`, `aria-pressed`, and live regions when
  their state changes are meaningful.
- Keep text and controls at accessible contrast ratios in every semantic state.
- Pair status color with text, icon, shape, or an explicit label. Do not use
  color as the only unread, assignment, delivery, health, or error signal.
- Respect reduced-motion preferences. Motion is for feedback or orientation,
  never decoration.
- Maintain usable hit targets and readable text at zoom; do not encode meaning
  in hover alone.

## 20. Shared component ownership

Future shadcn primitives belong in shared UI components. Shared primitives must
not be modified solely to solve one feature-specific styling problem.

Prefer, in order:

1. an existing shared variant;
2. composition around the primitive; and
3. a feature component for feature-specific behavior.

Add a new shared variant only when the pattern is genuinely reusable across
screens and has stable semantics. Keep status, button, form, menu, dialog, and
layout patterns centrally consistent.

## 21. Anti-patterns

Do not:

- wrap every section or row in a card;
- use excessive rounded containers, floating shadows, or decorative gradients;
- use oversized marketing-style headings or very large empty whitespace in the
  authenticated workflow;
- hardcode arbitrary Tailwind/CSS color literals in feature screens;
- create page-specific status colors or badge treatments;
- build multiple competing navigation systems;
- add decorative widgets that do not support a support workflow;
- put customer and agent messages at the extreme edges of a wide thread;
- print full timestamps on every message;
- hide `PENDING` or `FAILED` delivery states;
- use color alone for status or attention;
- use browser alerts/confirms for product interactions; or
- add CRM, analytics, workflow, role-builder, or quality-center UI outside the
  frozen Lean V1 scope.

## 22. Implementation contract

- `DESIGN.md` defines design and interaction rules for the product.
- Semantic design tokens in code define the actual visual values.
- Shared UI components implement recurring patterns.
- Feature screens compose those primitives and own feature-specific behavior.
- UI work preserves product behavior defined by the Lean V1 PRD and
  implementation documents, including permissions, assignment boundaries,
  lifecycle, delivery truth, AI freshness, handoff, and reply-window rules.
- Do not introduce one-off styling when an established token or shared pattern
  exists.
- When the current rough UI conflicts with this contract, the contract governs
  future presentation; when this contract conflicts with frozen product
  behavior, the product and implementation documents govern behavior.

# Right-pane tab contract (researched from the harness checkout)

Notes for the planned Memory tab in the right Sidebar. Recorded so the contract does
not have to be re-derived.

## Where the contract lives

- `packages/client/ui-sidebar-right/src/client/tab-registry.ts` — `SidebarRightTabDefinition`,
  `SidebarRightGuideEntry`, `SidebarRightTabRegistry.register()`.
- `packages/client/ui-sidebar-right/src/client/service.ts` — the `sidebarRight` service,
  including `openTab(kind, options)` and `openTabs`.
- `packages/client/ui-sidebar-right/src/client/index.ts` — a shipped registration example
  (the guide tab) and the seat registrations.
- `packages/client/ui-sidebar-browser/src/client/index.ts` — the closest full example:
  a real tab type with body, title, controller, and guide entry.
- `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` — the catalog of
  every slot, with `registerOptions` and example code.

## The tab type

```js
ctx.sidebarRightTabs.register({
  id: '@local/dsh-memory',       // unique across every registration; the key the body
                                 // and title register under
  kind: 'memory',                // the discriminator `openTab` names
  title: () => 'Memory',         // required: the chip's initial text
  keepMounted: true,             // optional: survive hiding, session changes, docking
  // patterns omitted => a "page type": opened by kind, recognizes no address
  priority: 'extension',         // default for a type from outside the product
  guide: [{ id: 'memory', order: 30, title: () => 'Memory', description: () => '…' }],
})
```

`register` throws when the `id` is taken, or when the `kind` is held by a registration
the band cannot coexist with. An `extension` and a `builtin` may pair on one kind once;
a `fallback` shares its kind with nothing.

## The two seats

```js
ctx.slots.register({ name: 'sidebar.right.pane.tab',       key: '@local/dsh-memory' }, Body)
ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: '@local/dsh-memory' }, Title)
```

`sidebar.right.pane.tab` is a **keyed** slot dispatched by `tab.kind`, scoped to the
session — a type registers here under its definition `id` and receives every tab of that
kind, in every pane, docked or floating. Its register options accept `locale`, `store`,
and an `inject(sessionId, actions)` factory; the browser package uses `inject` to build one
controller per session.

`sidebar.right.pane.tab.title` is the same key, and renders the chip.

## Opening it

- `ctx.sidebarRight.openTab(kind, options)` — options include `paneId`, `preferNewPane`,
  `replaceTab`, `revealIfOpened`, `kind`, and `params`.
- The guide entry is what puts a capsule on the shipped guide page, which is how a user
  opens a page type without a resource address.

## Required services

`inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']` on the client plugin's
returned object. `sidebarRight` and `sidebarRightTabs` are client services, not modules,
so they belong in that array rather than in `package.json`'s `dsh.client.inject`.

## Not the right seat

`rightbar.session` is `kind: 'single'` and `ui-sidebar-right` already occupies it with its
guide pane, so a plugin registering there would contend for one seat rather than adding a
tab.

## What the Memory tab will contain

Chosen scope: the working surface, with the settings tab kept as the configuration surface.

1. Inbox files — upload, remove, re-index (enabled by the read-only finding that
   `removeInboxFile` and re-index have no route yet).
2. Indexed sources grouped by collection.
3. A corpus search box over `POST /api/memory/search` limited to corpus tiers.
4. The vector report with its two actions (re-embed, purge).

## REST the tab needs beyond what exists

| Need | Status |
|---|---|
| `GET /api/memory/corpus/sources` | exists; needs the inbox's ingested state |
| `POST /api/memory/corpus/upload` | exists |
| remove an indexed source | **missing** |
| remove an inbox file | **missing** (`removeInboxFile` is written and tested, unexposed) |
| re-index one source or inbox file | **missing** (force re-ingest) |
| `POST /api/memory/search` | exists |
| `GET /api/memory/status` | exists, carries the vector report |
| `POST /api/memory/vectors/reembed` / `purge` | exist |

## Theme tokens that actually exist

The first version of the Memory tab styled itself with invented names
(`--dsw-alias-surface-subtle`, `--dsw-alias-text-muted`, `--dsw-alias-border-subtle`,
`--dsw-alias-text-danger`, `--dsw-alias-surface-interactive`, `--dsw-alias-font-monospace`).
None of those exist. Every `var(...)` therefore fell through to its hard-coded light
fallback, which is why the tab rendered as pale cards behind dark form controls inside a
dark theme.

Extracted from `packages/client` and `apps/web` (full set):

```
--dsw-alias-bg
--dsw-alias-bg-base
--dsw-alias-bg-document-preview
--dsw-alias-bg-l1
--dsw-alias-bg-l2
--dsw-alias-bg-layer-1
--dsw-alias-bg-layer-2
--dsw-alias-bg-layer-3
--dsw-alias-bg-layer-4
--dsw-alias-bg-mask-1
--dsw-alias-bg-mask-2
--dsw-alias-bg-mask-3
--dsw-alias-bg-mask-drop
--dsw-alias-bg-mask-photo
--dsw-alias-bg-module-platform
--dsw-alias-bg-multi-select
--dsw-alias-bg-overlay
--dsw-alias-bg-skeleton
--dsw-alias-border-inverted
--dsw-alias-border-inverted2
--dsw-alias-border-l1
--dsw-alias-border-l2
--dsw-alias-border-l2-darkmode-thin
--dsw-alias-border-l3
--dsw-alias-border-l4
--dsw-alias-brand-primary
--dsw-alias-brand-primary-invert
--dsw-alias-brand-primary-new-colorprimary-new-color
--dsw-alias-brand-text
--dsw-alias-button-contrast-fill
--dsw-alias-button-elevated-fill
--dsw-alias-button-floating-fill
--dsw-alias-button-floating-hover
--dsw-alias-button-ghost-active-border
--dsw-alias-button-ghost-active-fill
--dsw-alias-button-ghost-active-hover
--dsw-alias-button-info-fill
--dsw-alias-button-info-hover
--dsw-alias-button-primary-dimmed
--dsw-alias-button-primary-fill
--dsw-alias-button-primary-hover
--dsw-alias-button-tool-bar-fill
--dsw-alias-button-tool-bar-fill-invisible
--dsw-alias-button-tool-bar-hover
--dsw-alias-code-diff-added
--dsw-alias-code-diff-deleted
--dsw-alias-fg
--dsw-alias-file-diff-added-bg
--dsw-alias-file-diff-added-gutter
--dsw-alias-file-diff-added-marker
--dsw-alias-file-diff-deleted-bg
--dsw-alias-file-diff-deleted-gutter
--dsw-alias-file-diff-deleted-marker
--dsw-alias-fill-l1
--dsw-alias-fill-l2
--dsw-alias-fill-tertiary
--dsw-alias-fill-tsp-secondary
--dsw-alias-interactive-bg-active
--dsw-alias-interactive-bg-hover
--dsw-alias-interactive-bg-hover-accent
--dsw-alias-interactive-bg-hover-danger
--dsw-alias-interactive-bg-hover-solid
--dsw-alias-label-caption
--dsw-alias-label-dimmed
--dsw-alias-label-document-preview
--dsw-alias-label-error
--dsw-alias-label-primary
--dsw-alias-label-primary-bluish
--dsw-alias-label-primary-dimmed
--dsw-alias-label-primary-foreground
--dsw-alias-label-primary-inverted
--dsw-alias-label-quaternary
--dsw-alias-label-secondary
--dsw-alias-label-tertiary
--dsw-alias-link
--dsw-alias-markdown-citation
--dsw-alias-markdown-code-block
--dsw-alias-markdown-code-block-banner
--dsw-alias-markdown-code-segment-selected
--dsw-alias-markdown-code-segment-unselected
--dsw-alias-markdown-inline-code
--dsw-alias-markdown-placeholder
--dsw-alias-markdown-tag
--dsw-alias-scrollbar-bg-l1
--dsw-alias-scrollbar-bg-l2
--dsw-alias-scrollbar-hover-l1
--dsw-alias-scrollbar-hover-l2
--dsw-alias-separator-primary
--dsw-alias-state-business-primary
--dsw-alias-state-business-tertiary
--dsw-alias-state-error-primary
--dsw-alias-state-error-secondary
--dsw-alias-state-idle-primary
--dsw-alias-state-success-primary
--dsw-alias-state-success-secondary
--dsw-alias-state-success-tertiary
--dsw-alias-state-warn-label
--dsw-alias-state-warn-primary
--dsw-alias-state-warn-secondary
--dsw-alias-state-warn-tertiary
--dsw-alias-state-warning-primary
--dsw-alias-toast-bg
--dsw-alias-tooltip-bg
```

There is **no** font-family token and no generic `surface` / `muted` / `danger` name. The
mapping to use:

| Concept | Token |
|---|---|
| Panel background | `--dsw-alias-bg-layer-2` (on a `bg-layer-1` shell) |
| Border | `--dsw-alias-border-l2`, separators `--dsw-alias-separator-primary` |
| Body text | `--dsw-alias-label-primary` |
| Muted text | `--dsw-alias-label-tertiary`, captions `--dsw-alias-label-caption` |
| Error text | `--dsw-alias-label-error` |
| Success text | `--dsw-alias-state-success-primary` |
| Primary button | fill `--dsw-alias-button-primary-fill`, hover `--dsw-alias-button-primary-hover` |
| Secondary button | fill `--dsw-alias-button-elevated-fill` |
| Input fill | `--dsw-alias-fill-l1`, hover `--dsw-alias-interactive-bg-hover` |
| Monospace | no token; use a literal stack |

Every `var()` needs a dark-safe fallback or none, and every form control needs explicit
`background`, `color`, and `border` — without them the user agent's own theme shows
through, which is what produced dark inputs on pale cards.

## Layout problems visible in the first render

1. The body repeated "Memory" directly under a tab chip already reading "Memory".
2. The session id was printed as a prominent monospace line; it is diagnostic noise.
3. Empty states ("Empty.", "Nothing indexed yet.") occupied full-height pale cards.
4. The Search button rendered blank — its label had no contrast against its fill.
5. Form controls (file input, text inputs, buttons) were left at user-agent styling, so
   they looked like a different application from the pane they sat in.
6. Section cards all had the same weight, so nothing read as primary.

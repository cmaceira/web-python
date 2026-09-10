# Architecture

How the page, the Python worker and the stdin channel fit together — and where
the implementation deliberately differs from the spec's *Data & Interfaces*.

```
┌──────────────────────────── main thread ────────────────────────────┐
│  index.html + src/main.ts                                           │
│    flat file tree + CodeMirror + completion + Tab indentation + paste │
│      └─ autosave → localStorage['pyplay.workspace.v1']               │
│    color mode ── pyplay.theme.v1; editor darkTheme from effective   │
│    layout ── pyplay.layout.v2; #app[data-layout] drives the grid    │
│    diagnostics height ── pyplay.diagnostics-height.v1; #diag-resizer │
│    console (rAF-batched, bounded)                                   │
│    status bar, toolbar, stdin field, diagnostics panel              │
│    Ruff-WASM (lint + format, in-thread)                             │
│    src/runtime.ts ── owns the worker, runIds, stop-and-replace       │
└───────────┬──────────────────────────────────┬──────────────────────┘
            │ postMessage (init / run)         │ SharedArrayBuffer
            │ postMessage (ready / stdout /…)  │ + Atomics.wait/notify
┌───────────▼──────────────────────────────────▼──────────────────────┐
│  src/worker/pyodide.worker.ts — a dedicated Web Worker              │
│    Pyodide 0.28.x (CPython 3.13 → WASM), loaded from /pyodide/      │
│    a Python runner that executes the program as a fresh __main__    │
│    a Python stdin shim delegating to src/stdin-stream.ts            │
└─────────────────────────────────────────────────────────────────────┘
```

The visitor's program **never** runs on the main thread. That is what makes
Stop unconditional: a runaway `while True: pass` can be killed with
`worker.terminate()` because it was never holding the UI.

Python paste cleanup is also main-thread-only and synchronous. A CodeMirror
transaction filter inspects only native `input.paste` transactions for the
active lowercase `.py` file. It parses the post-paste document twice: first to
repair smart quote delimiters outside existing strings/comments, then to map
Unicode spaces, formatting characters, line separators, and lookalike dashes
only in code. F-string literal text is protected while replacement expressions
remain code. The cleanup changes are composed sequentially into the original
paste transaction, so autosave and lint see only the final text and one Undo
removes the entire paste. No notice, storage key, worker message, clipboard
write, Ruff call, or network request is involved.

CodeMirror's `indentUnit` is four ASCII spaces. Its native `indentWithTab`
binding runs below completion acceptance, so `Tab` first accepts an open
completion and otherwise indents the current or selected lines; `Shift+Tab`
dedents one level. The default keymap's `Ctrl+M` (`Shift+Alt+M` on macOS)
toggles Tab-focus mode, allowing browser focus navigation to leave the editor
without a custom keyboard handler.

The indentation highlighter paints a faint background dot for each leading
space without replacing source characters; spaces inside code and strings are
left alone. The editor panel and CodeMirror scroller cap their inline size,
while the vertical Files/Editor/Console tracks use `minmax(0, …)` so
indentation stays inside the editor's own scrolling area instead of
redistributing the page columns.

---

## Main ↔ worker message protocol

Messages are structured-clone-able objects with a `type` discriminator. The
types live in [`src/protocol.ts`](../src/protocol.ts).

### Main → worker

| `type` | Payload | Meaning |
|---|---|---|
| `init` | `{ stdinBuffer, fsBuffer: SharedArrayBuffer }` | Boot Pyodide; adopt the stdin channel and filesystem-operation mailbox. Sent once per worker, immediately after it is spawned. |
| `run` | `{ files, entryFile, runId }` | Hydrate the flat workspace and execute the selected UTF-8 `.py` file as `__main__` in a brand-new namespace. |

**Stop is not a message.** It is `worker.terminate()` — see
*Stop and replace* below.

### Worker → main

| `type` | Payload | Meaning |
|---|---|---|
| `ready` | `{ pythonVersion: string }` | The runtime is initialised. |
| `initError` | `{ message: string }` | The runtime failed to initialise. |
| `stdout` | `{ runId, text }` | A chunk of `sys.stdout`. |
| `stderr` | `{ runId, text }` | A chunk of `sys.stderr`. |
| `fsMutationAvailable` | `{ runId, sequence }` | A Python filesystem operation is ready in the shared mailbox for the page to persist. |
| `workspaceSnapshot` | `{ runId, files }` | The authoritative flat workspace after the run exits. |
| `stdinRequest` | `{ runId, prompt, mode }` | The program is suspended on a blocking read. **`mode` is an addition — see below.** |
| `done` | `{ runId, durationMs }` | Normal termination. |
| `error` | `{ runId, traceback }` | Uncaught exception; `traceback` is the full CPython traceback with the runner's own frame stripped. |

### Deviation from *Data & Interfaces*: `stdinRequest.mode`

The spec's table gives `stdinRequest` the payload `{ runId, prompt }`. The
implementation adds a third field:

```ts
{ type: 'stdinRequest'; runId: number; prompt: string; mode: 'line' | 'stream' }
```

**Why.** The spec requires two different stdin-field behaviours after a
submission, and only the worker knows which applies:

- for a *line-based* read (`input()`, `sys.stdin.readline()`) the field is
  cleared and **disabled** after the visitor submits one line — the read is
  satisfied;
- for a *stream* read (`sys.stdin.read()`, or `sys.stdin.read(n)` that is still
  short of `n` characters) the field is cleared but **stays enabled**, because
  the read wants more lines or an EOF.

Without `mode`, the main thread would have to guess which kind of read it is
answering, or the worker would have to emit a second message after every
submission. `mode` is the smaller, race-free option: one extra scalar on a
message the worker is already sending, at the only moment when the answer is
known. `'line'` covers `input()`/`readline()`; `'stream'` covers
`read()`/`read(n)`.

The workspace protocol extends the original single-file interface so Python
can create and update local exercise files without cloud storage.

### Other implementation choices the spec leaves open

- **The worker is a classic worker, not a module worker.** It pulls the
  self-hosted Pyodide loader in with `importScripts('/pyodide/pyodide.js')`, so
  the runtime is fetched from this origin with no CDN and no bundler
  indirection.
- **`init` carries the buffer from the very first boot**, not only after a
  Stop. Every worker gets its own channel; nothing is ever reused.
- **Ruff runs on the main thread**, not in a worker. Lint and format of a
  500-line file each measure well under their 300 ms budget, and keeping Ruff
  in-thread means Format can be a single, synchronous, undoable editor
  transaction.

---

## `runId` discipline

`runId` is allocated by the **main thread** (`src/runtime.ts`), starts at 1,
increments on every Run, and is **never reset** — not when a worker is
terminated, not when one is replaced.

The main thread keeps exactly one `currentRunId`. Every inbound message that
carries a `runId` is passed through `isCurrentRun()`; anything that does not
match is dropped on the floor:

```ts
export function isCurrentRun(message: FromWorker, currentRunId: number | null): boolean {
  if (!('runId' in message)) return true;               // ready / initError
  return currentRunId !== null && message.runId === currentRunId;
}
```

Because ids are monotonic and never recycled, a message still in flight from a
worker that has just been terminated can never be mistaken for output of the
current run. `currentRunId` is also set to `null` the instant Stop is pressed,
so *nothing* from the dead worker is acted on even before its replacement
exists.

There is a second, cheaper guard on the same problem: the message listener
closes over the `Worker` instance it was installed on and returns immediately
if `this.worker !== worker`. The `runId` check is the one that matters for
correctness; the identity check just stops the work earlier.

---

## The `SharedArrayBuffer` stdin channel

This is why the whole site must be cross-origin isolated. `Atomics.wait` on a
`SharedArrayBuffer` is the only way to park a WebAssembly interpreter on a
value that the main thread will produce later, which is exactly what a blocking
`input()` is.

### Wire format

One buffer per worker, handed over with `init`. It is a 4-slot `Int32Array`
header followed by a UTF-8 payload
([`src/stdin-channel.ts`](../src/stdin-channel.ts)):

| Slot | Meaning |
|---|---|
| 0 | control word — `0` = empty, `1` = a submission is waiting |
| 1 | `1` when the submission is EOF rather than text |
| 2 | payload length, in bytes |
| 3 | reserved |

The payload region is sized for one submitted line of 65 536 code points at up
to 4 UTF-8 bytes each, plus the `\n` the main thread appends — the same cap
the UI enforces before it ever writes (`Input line too long (max 65536
characters)`).

### The cycle

1. The Python shim calls a blocking read.
2. The worker posts `stdinRequest { runId, prompt, mode }` and then parks in
   `Atomics.wait(header, CONTROL, CONTROL_EMPTY)` — nothing else in the worker
   runs.
3. The main thread renders the prompt (exactly once, from the message — the
   worker's shim consumes it so it never reaches the `stdout` stream), enables
   and focuses the stdin field, and waits for the visitor.
4. On submit, the main thread writes the line **plus a trailing `\n`** into the
   payload, sets `length`, clears the EOF flag, stores `1` into the control
   word and calls `Atomics.notify`. Send EOF instead sets the EOF flag with a
   zero-length payload.
5. The worker wakes, `takeSubmission()` reads the payload and **resets the
   control word to `0`**, so the channel is immediately ready for the next
   submission of the *same* read.
6. If the read is not yet satisfied, the worker parks again — step 2 without a
   new `stdinRequest` for `read()`/`read(n)`, because the field is already open.

Reads are unlimited in number and may sit anywhere in the program: top level,
loop bodies, function calls, `try` blocks, after arbitrary computation. Each
one suspends and resumes independently.

### Consumption semantics

The pure state machine lives in
[`src/stdin-stream.ts`](../src/stdin-stream.ts) — no DOM, no `Atomics` — so it
is unit-testable in Node. It buffers **code points**, not bytes, so `read(n)`
counts the way CPython does.

| API | Blocks until | Returns | Field after a submission |
|---|---|---|---|
| `input()` | one line, or EOF | the line without its trailing `\n`; raises `EOFError` on EOF before a line | disabled (`mode: 'line'`) |
| `sys.stdin.readline()` | one line, or EOF | the line **including** `\n`; `''` on EOF before a line | disabled (`mode: 'line'`) |
| `sys.stdin.read()` | EOF | every buffered character; `''` on immediate EOF | stays enabled (`mode: 'stream'`) |
| `sys.stdin.read(n)` | `n` characters, or EOF | the first `n` characters; the partial buffer if EOF arrives first | stays enabled while short of `n` (`mode: 'stream'`) |

EOF is **latched** for the run: once it has been delivered, every later read
returns immediately rather than re-opening the field. `reset()` clears the
buffer and the latch at the start of every run, so nothing survives from a
previous one.

The prompt of `input(prompt)` travels **only** in `stdinRequest.prompt`. The
worker's shim flushes `stdout` and `stderr` before it suspends — so console
ordering matches a terminal's — and then swallows the prompt instead of writing
it, which is what makes "the prompt appears exactly once" true.

---

## Stop and replace

Stop is deliberately not a message: a message would have to be *received*, and
a program spinning in a tight loop never yields to the worker's event loop.

```
Stop pressed
  ├─ worker.terminate()                    execution ceases immediately
  ├─ currentRunId = null                   nothing in flight is ever acted on
  ├─ state = 'restarting'
  ├─ onStopped()   → console "Program stopped.", status "Restarting Python…",
  │                   Run disabled, stdin field disabled
  ├─ onRunStateChange(false)
  └─ spawn()
       ├─ new Worker(<script URL>)         a fresh interpreter, from scratch
       ├─ new SharedArrayBuffer            a brand-new stdin channel
       ├─ postMessage({ type: 'init', … })
       └─ on 'ready' → onRecovered()
            status returns to its steady value, Run is enabled again,
            and **no** second "Python … ready" line is appended
```

Recovery is silent by design: the console belongs to the visitor's program, and
a runtime restart is not program output. The budget is 5 seconds from Stop to
Run being enabled again, with no page reload.

The same replacement is what guarantees a fresh namespace on every run after a
stop or a crash — there is literally no interpreter left to leak state.

### The respawn URL carries a query string

`PyodideRuntime.spawn()` loads the *first* worker from the bundled script URL
and every **replacement** from `<url>?respawn=<n>`.

This is a WebKit workaround, and a necessary one: in WebKit a worker script
replayed from the HTTP cache arrives without the
`Cross-Origin-Embedder-Policy` header its original response carried, and the
COEP-`require-corp` document then refuses to start it
(*"Refused to load … worker because of Cross-Origin-Embedder-Policy"*).
Without the query string, the first Stop in Safari would be the last: the
replacement worker never loads and the page is stuck at `Python unavailable`.

The cost is one refetch of a ~6 KB script per Stop. The service worker looks
cache entries up with `ignoreSearch: true`, so the respawn URL is still served
from the precache bucket when the network is gone, and no manifest URL carries
a query string of its own.

---

## Inert controls (FR-049 vs FR-054 / FR-058)

Two requirements pull in opposite directions:

- keyboard traversal must reach **every** control — Run, Stop, Clear console,
  Copy code, Format, the editor, the stdin field, Send EOF and the diagnostics
  entries — each showing a visible focus indicator;
- Stop must be visibly disabled and non-activatable whenever nothing is
  running, and Format likewise when the lint engine failed to load.

A natively `disabled` control satisfies the second and violates the first: the
browser removes it from the tab order.

The resolution is in [`src/controls.ts`](../src/controls.ts). No
conditionally-inert control ever uses the `disabled` attribute. Instead:

- `aria-disabled="true"` plus an explicit `tabindex="0"` — focusable,
  announced as disabled, and styled by `.btn[aria-disabled='true']` /
  `.stdin-input[aria-disabled='true']`;
- the stdin field additionally carries `readonly`, so it takes focus but
  refuses text;
- **every** activation path is guarded by `isInert()` inside its handler:
  click, `Enter`, `Space`, `Ctrl/Cmd+Enter`, `Shift+Alt+F` and `Ctrl+D`.

`setInert()` writes the attribute only when it actually changes, so a
`MutationObserver` watching `aria-disabled` sees exactly one record per
transition. `aria-disabled` is also what Playwright's `toBeDisabled()` and
`toBeEnabled()` report, so the inertness criteria read unchanged in the tests.

Related: `Tab` indents in the editor (issue #31). CodeMirror's built-in
Tab-focus mode preserves keyboard access to the stdin field, Send EOF and the
diagnostics entries: press `Ctrl+M` (`Shift+Alt+M` on macOS), then use Tab or
Shift+Tab for browser focus traversal.

---

## Console

Output arrives as chunks and is painted on a `requestAnimationFrame` batch, so
a program printing tens of thousands of lines a second never blocks the main
thread for more than a frame — and Stop still lands inside its 500 ms budget.

Two caps keep memory bounded:

- **5 000 lines per run.** Older lines are dropped and a
  `… earlier output truncated …` marker heads the retained region.
- **100 000 characters per write.** The remainder is replaced by
  `… line truncated (N characters dropped) …`.

The view stays pinned to the bottom only while it *is* at the bottom; once the
visitor scrolls up, new output no longer moves the viewport, and returning to
the bottom re-pins it.

---

## Special-character pane

The pane of spec-03 (`src/symbol-pane.ts`, `src/symbols.ts`) is a
**roving-tabindex toolbar**: 29 buttons, exactly one of which carries
`tabindex="0"` at any moment, so `Tab` from the toolbar reaches the pane once
and once only (BR-305). 29 separate tab stops between the toolbar and the
editor would have made keyboard operation of the playground's core loop
materially worse, which is why the arrow keys — not `Tab` — move within it.

Its container is `role="toolbar"`, not `role="group"`, because that is the role
that tells assistive technology this is a *composite widget whose arrow keys
navigate*. `aria-orientation` follows the layout: `vertical` in the ≥ 700 px
column, `horizontal` in the wrapping band below it. The breakpoint lives twice
— `WIDE_LAYOUT_QUERY` in `symbol-pane.ts` and one `@media` block in
`styles.css` — and the two must always be changed together.

Focus movement is resolved against the grid the pane *currently renders*:
visual rows are derived from `getBoundingClientRect().top` at keystroke time,
so one implementation is correct at both breakpoints and at any zoom level,
without duplicating the media query in JavaScript.

### One owner of the feedback state

FR-307 (`Copied V` for 2 000 ms), FR-308 (the denial notice) and FR-316 (a pane
closed while a write is in flight) are only consistent with each other because
a single method, `clearFeedback()`, is the sole writer of that state — it drops
the status text, removes `data-state="copied"` and cancels the pending revert
timer. Both paths call it *before* they write anything, and `close()` calls it
too. That is what makes a second copy restart the window from zero, a denial
after a recent success leave nothing behind, and a resolution that arrives
after the pane closed produce no feedback at all. Every activation also carries
a monotonic id, so an overtaken write resolves into nothing rather than into
stale text.

### It never touches the editor

The pane copies to the clipboard and does nothing else (BR-301). It holds no
reference to the `EditorView`, so it can produce no CodeMirror transaction —
and therefore no undo entry, no autosave schedule (FR-002) and no lint schedule
(FR-035). That is what keeps this feature incapable of regressing spec-01's
shipped behaviour, and it is why insert-at-caret was left out: it would put the
pane inside exactly those paths. `VC-307` checks the buffer, the caret offset
and the undo history across all 29 copies.

`.symbol` sets `user-select: text` because Firefox refuses to select content
inside a `<button>` otherwise, which would leave FR-308's fallback — "select
the character and press Ctrl/Cmd+C" — advising an impossible action there.

### Changing the character set is gated

The 29 entries are a compile-time constant transcribed from spec-03's
*Character set* table, which is normative. **BR-302** gates any change to it:
every entry must be a Python 3 token or a punctuation character that appears in
Python 3 source, and adding one requires naming the construct that uses it.
Characters that merely *look* like Python operators — `≤`, `≠`, `×`, `÷`, the
typographic quotes, full-width parentheses — are forbidden, because a student
who pastes `“` gets `SyntaxError: invalid character '“' (U+201C)` with no idea
why. `VC-325` greps the compiled set for exactly those code points.

---

## Offline name completion

`src/completion.ts` combines CodeMirror Python's scope-aware local source with
its built-in globals and the complete CPython 3.13 hard/soft keyword lists.
The merge is ordered: active-file locals enter first and win duplicate labels;
keywords and globals follow. Each option keeps its type for the CodeMirror icon
but is normalized to literal-label insertion with no snippet function, detail,
signature, or documentation.

The source walks the Lezer syntax tree before producing results. It suppresses
comments, ordinary strings, the entire formatted-string subtree, and parsed
property names. A direct character check before the identifier also suppresses
temporarily incomplete member expressions after `.`.

Completion is an editor extension only. It sends no worker message and has no
reference to Pyodide, Ruff, the workspace store, or the service worker. An
accepted option is a normal CodeMirror transaction, so the existing active-file
autosave and lint listeners observe it. A run already in progress continues
with the full workspace and entry-file snapshot captured by Run.

`@codemirror/autocomplete` owns listbox semantics and its standard keymap:
`Ctrl+Space`, arrows/page keys, `Enter`, and `Escape`. A guarded `Tab` binding
calls CodeMirror's own acceptance command; when no completion is active it
returns false, preserving the traversal described under *Inert controls*.
Only the active editor document contributes local names; sibling files and
imports are outside this syntactic feature.

---

## Horizontal / vertical layout

Spec-04 adds one switch and nothing else: **`#app[data-layout]`**, set to
`horizontal` or `vertical`. Everything the visitor sees follows from that one
attribute and the CSS keyed off it. No class is toggled, no element is moved,
and the worker is never told the layout exists (BR-401).

### What the two names mean

**Both name the orientation of the divider between the panels**, which is the
convention `vim`'s `:split` / `:vsplit` uses:

| Value | Rendering |
|---|---|
| `horizontal` | panels separated by *horizontal* rules, stacked top to bottom in one column — spec-01's shipped layout, and the only one below 900 px |
| `vertical` | panels separated by a *vertical* rule — editor in a full-height inline-start column, console / stdin / diagnostics stacked inline-end |

The opposite convention is equally common: `tmux`'s `split-window -h` produces
side-by-side panes, naming the axis the panes run *along* rather than the
divider. Either choice reads backwards to half of everyone, so the point is not
that this one is right — it is that it is **fixed and written down**.
`src/layout.ts` is normative, and the doc comment on `Layout` says so. Changing
the interpretation of either word means changing the type, the labels in
`index.html`, the CSS selectors in `styles.css` and the storage key together.

That storage key is why this is more than a cosmetic decision. `v1` shipped
with the *other* convention, so a `v1` value read under `v2`'s meaning would
silently hand the visitor the layout they did not choose. The key is therefore
superseded, not migrated — exactly the case BR-403 anticipated when it said a
two-value enum "will only ever be superseded, never migrated". A stale
`pyplay.layout.v1` is simply never read again.

`src/layout.ts` holds the whole decision as three pure functions, so FR-411's
rule and FR-417's tolerance for junk in storage are unit-testable without a
DOM. The rule itself is one line: **stacked (`horizontal`) below 900 px,
otherwise the stored preference, otherwise two columns (`vertical`).** Nothing
else may set `data-layout`.

### The breakpoint lives twice, and must be changed twice

`LAYOUT_MIN_WIDTH` (900) is evaluated on the main thread as
`matchMedia('(min-width: 900px)')` and mirrored by a single
`@media (min-width: 900px)` guard in `styles.css`. The mirror is the point: the
CSS *cannot* paint two columns that the resolver did not choose, because the
two-column rules only exist inside the same query the resolver consults. This
is the same discipline spec-03 applies to its own 700 px pane breakpoint, and
it has the same obligation — change one and you must change the other.

Re-resolution is subscribed to the `matchMedia` `change` event and runs
synchronously in the handler. There is deliberately **no `resize` listener and
no debounce**: `change` fires once per crossing rather than once per pixel, so
the cheap thing is also the correct thing (FR-412). A resize never writes to
storage, which is what lets an unset preference track the viewport while a
chosen one stays sticky (BR-405).

### Document order is fixed, and that is load-bearing

Both layouts render the same four panels in the same document order — console,
editor, stdin, diagnostics — and the columns are produced by
`grid-template-areas` placement only (FR-410, BR-402). The diagnostics
separator (`#diag-resizer`) is a non-panel sibling inserted immediately after
the editor and before stdin; it is never a re-parent of any panel. Two separate
things depend on the fixed panel order:

- **CodeMirror.** Re-parenting the editor element forces a re-measure and drops
  focus and selection, which would break FR-419 outright. Because the element
  never moves, a switch costs one repaint and the `EditorView` is the same
  object afterwards — `VC-420` asserts object identity, not just equal state.
- **WCAG SC 2.4.3.** Fixed panel order keeps reading order stable. When the
  separator is active (two-column layout at ≥ 900 px) sequential focus visits
  editor → separator → stdin → diagnostics; when it is inert it drops out of
  the interactive path but stays in the DOM. That is only safe because **the
  console panel contains no focusable element** (BR-407): focus still matches
  visual order top to bottom. Any future change that puts a tab stop inside
  the console has to re-verify SC 2.4.3 against this.

The grid is shared with spec-03's pane, not competing with it. `.app` has two
grid definitions, kept mutually exclusive by selector: spec-03's
`.app:not([data-layout='vertical']):has(#symbol-pane:not([hidden])))` and
spec-04's `#app[data-layout='vertical']`. The pane keeps its full-height
inline-end column in *both* layouts. The `:not()` also matches when the
attribute is absent, so a JavaScript failure leaves spec-03 rendering exactly
as it shipped.

### Diagnostics height in the two-column layout

In the stacked (`horizontal`) layout the diagnostics panel keeps its
`max-height: 25vh`. That behaviour is unchanged.

In the two-column (`vertical`) layout at ≥ 900 px the Problems panel under
Input starts at the same **content-sized empty height** as the stacked
(`horizontal`) layout — Problems title, live count, and empty/body line, not a
free-space fraction — so the console keeps the room. Visitors who need a taller
list enlarge it; the chosen height is remembered on this origin. This is not a
hide or collapse of either panel (issue #21); both stay in the layout.

#### How the height is applied

The right-column grid rows are: console `minmax(80px, 1fr)`, an 8 px separator
track (`diagsep`), content-sized stdin, then diagnostics sized by the CSS
custom property `--diagnostics-height` on `document.documentElement`. When that
property is unset, the diagnostics track is `auto`: the empty state keeps its
intrinsic line (matching horizontal) while the findings list stays
flex-collapsed (`flex-basis: 0` with `min-height: 0`) so a content-derived
default paints without waiting on JavaScript measurement and without an `fr`
share.

A render-blocking bootstrap in `index.html` reads
`pyplay.diagnostics-height.v1` and, when the value is a canonical integer
string, sets `--diagnostics-height` before first paint so a restored height
does not flash a large free-space share.

#### The separator

`#diag-resizer` sits between the console and the stdin row visually
(`grid-area: diagsep`) with `role="separator"`, `aria-orientation="horizontal"`,
and accessible name `Resize diagnostics panel`. Pointer drag and `ArrowUp` /
`ArrowDown` (with `Shift` for a larger step) reallocate free space between the
console and diagnostics; stdin stays content-sized. Outside vertical layout at
≥ 900 px the control is CSS-hidden and made inert with `setInert()` — never the
HTML `disabled` attribute — so every activation path is a no-op.

#### Bounds and persistence

The minimum height is content-derived from the Problems title row, its margin,
one empty/body line, and the diagnostics panel's padding — matching the stacked
layout's natural empty height so font inflation cannot clip the count or the
empty line. The maximum is the lesser of 40 % of the right column's height
(console top to diagnostics bottom) and the height that still leaves the
console its 80 px floor — whichever bound is hit first, expressed as an integer
CSS-px height.

Committed resizes (pointer release, or a keyboard step that changes height)
write a canonical decimal integer string (no units, no leading zero) to
`localStorage['pyplay.diagnostics-height.v1']`. A clamp caused only by
viewport or layout change updates the in-memory height and `aria-valuenow` but
does **not** rewrite storage until the visitor next commits a resize. Missing
or non-canonical stored values are treated as absent (content-sized default) and
left in place. A rejected write still applies the height for the session and
shows `Diagnostics height won't be remembered` at most once per page load.

### The control

`#layout-group` is a `role="radiogroup"` with two `role="radio"` buttons and a
roving `tabindex` — the same single-tab-stop model spec-03 uses for the pane
and spec-01 for the diagnostics panel. `aria-checked` always reflects the
**effective** layout, never a stored preference the narrow override is
currently masking (FR-402).

Below 900 px the group is inert via `setInert()` — `aria-disabled`, never the
`disabled` attribute, so it stays in the tab order (see *Inert controls*
above) — and every activation and navigation path returns early, making FR-415
a strict no-op rather than a series of guarded special cases.

`Horizontal` is the **first** radio, so `Home` reaches the layout that is
always available and `End` the one the narrow override can take away.

It sits immediately after `#btn-reset` and *before* `#btn-symbols`. Spec-04's
DOM contract also called it the toolbar's last child, but spec-03 had already
shipped `Symbols` in that slot (VC-301); FR-401's own Given/When/Then says
"immediately after `#btn-reset`", which is what ships. Recorded as an amendment
in `specs/04-toogle-pane-aspect-frozen.md`.

### Toolbar presentation clustering

At viewports ≥ 900 px the toolbar is still one `flex` row with a fixed DOM
order, but it *looks* like two clusters: a leading action group (`#btn-run`
through `#btn-files`, including `#layout-group`) packed at the inline-start
edge, and a presentation cluster (`#btn-symbols`, `#btn-theme`, `#btn-about`)
flush with the inline-end edge. The split exists because the leading controls
act on the visitor's program / workspace while the trailing three act on how
the page is presented or identified; collecting free space between those
groups keeps the presentation cluster at a stable screen edge that does not
shift when `#run-file-name` re-labels `Run`.

The mechanism is presentational only: inside the same `@media (min-width:
900px)` block that mirrors `LAYOUT_MIN_WIDTH`, the toolbar sets
`flex-wrap: nowrap` and `#btn-symbols` gets `margin-inline-start: auto`. Flex
then parks all slack on that line between `#btn-files` and `#btn-symbols`, so
`#btn-theme` and `#btn-about` (the next siblings, still separated by the
toolbar's `6px` gap) ride with it to the inline-end. `#btn-about` is the
flush edge (spec-08). Nowrap is required because a wrapped row at exactly
900 px can fit Symbols after the leading cluster but drop a trailing icon
onto the next line alone when OS fonts run slightly wide; flex shrink absorbs
that variance instead. The margin uses a logical property so the arrangement
tracks writing direction the same way the layout switch does. `#btn-files`
stays in the leading cluster because it is a workspace control, not a
presentation control — only the named cluster moves visually.

Nothing is re-parented or reordered in the DOM, so tab order and assistive
enumeration stay `#btn-run` … `#layout-group` … `#btn-files` … `#btn-symbols`
… `#btn-theme` … `#btn-about`. Below 900 px neither rule applies: the toolbar
keeps `flex-wrap: wrap` and packs every control on every line against the
inline-start edge exactly as it did before.

## Color mode

The color-mode control of spec-05 (`src/theme.ts`, `#btn-theme`) lets the
visitor force Light, force Dark, or keep System. Two writers keep chrome in
sync without a flash:

1. **Inline bootstrap** in `index.html` — a render-blocking `<script>` in
   `<head>` that reads `pyplay.theme.v1`, validates the three canonical
   strings, sets `document.documentElement.dataset.theme` to the preference,
   samples `prefers-color-scheme` **once**, and sets `data-effective` plus
   the used `color-scheme` to the effective palette. It never waits on the
   Vite module and never registers a `change` listener.
2. **Module** (`src/theme.ts`) — re-reads the same key with the same
   allow-list, owns the toolbar cycle / persistence / glyph, and drives
   CodeMirror's `EditorView.darkTheme` compartment via
   `setEditorColorScheme`. On boot it re-applies the document attributes
   idempotently with the bootstrap.

`data-theme` always tracks the **preference** (`light` | `dark` | `system`);
`color-scheme` and `data-effective` always track the **effective** palette
(`light` | `dark`) — BR-506. When preference is System, CSS nests the dark
token block under `@media (prefers-color-scheme: dark)` only for that
attribute value; forced modes select tokens from `[data-theme="light"]` /
`[data-theme="dark"]` regardless of the OS.

System is **load-scoped** (BR-502): the OS sample taken at page load (and
reused when a mid-session cycle lands on `system`) is never refreshed by a
live `matchMedia` listener. A visitor who wants the new OS value reloads.

---

## About dialog

The About control answers “which build is this?” without leaving the page or
talking to a server. It is presentation-only: opening or closing it must not
touch the editor, the worker, stdin, the console, or `#notices`.

### Toolbar placement and binding

`#btn-about` is the **last** control in document order inside `header.toolbar`,
immediately after `#btn-theme`. At ≥ 900 px it rides with Symbols and theme in
the presentation cluster (see *Toolbar presentation clustering* above) and is
the flush edge at the toolbar's inline-end. Its visible glyph is the Latin
small letter `i`; the accessible name and `title` are `About`. Like
`#btn-theme` it carries an explicit `tabindex="0"` so WebKit keeps the icon
button in sequential focus, and it is never HTML-`disabled` / `setInert` for
About-related reasons.

`src/main.ts` calls `bindAboutControl` after `bindThemeControl`. The binder
lives in `src/about.ts`: it fills the four field nodes from `buildMeta`, opens
on pointer / Enter / Space, traps focus while open, and dismisses on Escape,
`#about-close`, or a click on `#about-backdrop`.

### Custom overlay (not `<dialog>`)

Markup for `#about-backdrop` and `#about-dialog` lives in `index.html` and
starts `hidden`. Behaviour is a fixed overlay plus a sibling backdrop — not
`HTMLDialogElement.showModal()`. That split exists so the dismiss layer is a
real element the tests and visitors can click (`#about-backdrop`), while a
synthetic activation of chrome under the dimmed area (e.g. `#btn-run`) is
swallowed without treating it as a backdrop dismiss. Do not switch to native
`<dialog>` without rewriting that contract.

### Bundle-local metadata

Version / Branch / Commit / Built are baked when Vite loads: `vite.config.ts`
calls `readBuildMetadata()` once and injects the object via
`define: { __PYPLAY_BUILD_META__: … }`. `src/build-meta.ts` exports
`buildMeta` for the app. The running page never fetches those four strings and
never reads them from `localStorage` / `sessionStorage` / cookies / IndexedDB
— they must survive Cache Storage and airplane mode the same way the rest of
the app shell does.

Two rules maintainers must not undo:

- **Commit is always plain text** — never an `<a href>`, never a GitHub URL.
  Linking would pull an off-origin dependency into an offline product.
- **Version comes from git tags** via the same `highestVersion` ordering as the
  release pipeline (not `package.json`). The dialog only *displays* a
  build-time snapshot; it does not retag or bump.

Per-palette `--about-backdrop` tokens keep the scrim distinguishable from the
page background under both effective themes (light darkens with black alpha;
dark *lightens* with white alpha). Do not collapse them back to a single
`color-mix` against `--fg` toward `transparent` — that fails contrast on dark.

Visitor-facing copy (`About`, field labels, `Close`, the glyph, `unknown`)
lives in `src/format.ts` with the rest of the chrome strings.

---

## Storage surface

The origin holds exactly five things, and nothing else — no cookies, no
IndexedDB, no `sessionStorage`:

| Store | Key | Contents |
|---|---|---|
| `localStorage` | `pyplay.layout.v2` | exactly `horizontal` (stacked) or `vertical` (two columns) — a bare string from a two-value enum, no JSON, no wrapper, no whitespace |
| `localStorage` | `pyplay.theme.v1` | exactly `light`, `dark`, or `system` — raw string, no JSON |
| `localStorage` | `pyplay.workspace.v1` | versioned flat workspace: active filename plus Base64 file bytes, capped at 2 MB |
| `localStorage` | `pyplay.diagnostics-height.v1` | canonical diagnostics panel height in CSS px: `^[1-9][0-9]*$` (e.g. `36`) — no JSON, no units, no whitespace |
| Cache Storage | `pyplay-assets-v<build>` | the precached static assets; older buckets are deleted on activation |

The workspace begins with the same friendly UTF-8 `main.py` used by the
original playground: a welcome message, a name prompt and a short squares loop.
It intentionally has no directories: names containing a path separator are
rejected in both the interface and the Python filesystem bridge. `Run` is
available only while the active file is UTF-8 and ends in `.py`; its name is
captured with the workspace snapshot, shown while it runs, and retained as the
Files panel's session-only `Last run` marker. Files written by Python are
mirrored to the page operation-by-operation through a `SharedArrayBuffer`, so
they appear in the tree and survive Stop; a final worker snapshot reconciles
the complete workspace. Non-UTF-8 files are retained but opened read-only.

Autosave is debounced 500 ms and additionally flushed **synchronously** on
`pagehide` and on `visibilitychange → hidden`, so a fast navigation away can
never persist a half-typed prefix. A rejected write (quota, private browsing,
storage disabled) shows one notice per page load and changes nothing else.
Theme storage failure is quieter still: the in-memory preference and UI still
cycle; no theme notice is shown (BR-504).
A legacy `pyplay.program.v1` value migrates once into `main.py`.

`pyplay.layout.v2` is written **synchronously on selection** — there is nothing
to debounce, and a layout choice that survived only if the visitor waited half
a second would be a bug. Because it is a two-value enum it needs no schema, so it is superseded rather
than migrated — `v2` is that supersession, and it is why a `v1` value is never
read (see *What the two names mean* above). Anything that is not exactly one of
the two literals is treated as absent and **left in place**, never rewritten
(FR-417). A rejected write shows one notice per page load and still
applies the layout for the session (FR-418, BR-406).

`pyplay.diagnostics-height.v1` is written only on a committed resize (see
*Diagnostics height in the two-column layout* above). Non-canonical values are
treated as absent and left in place; a rejected write keeps the in-memory
height and shows its own one-shot notice.

---

## Browser matrix

The spec pins eight browser versions. Playwright cannot install arbitrary
historical builds, so `playwright.config.ts` declares one project per pinned
name and maps it onto the closest engine it can actually launch. A project
whose engine is unavailable on the machine still exists — so the documented
eight-project command runs as written — but its test **skips**, and the runner
prints which ones. A skip is never a pass, so a matrix run can never report
coverage it did not earn.

The matrix is opt-in (`MATRIX=1`, set by `npm run test:matrix`) and runs
`--workers=1`. VC-024 asserts NFR-014's 5.0 s recovery budget, which the spec
states for the reference profile; six engines competing for one machine is not
that profile, and measuring under that contention times the machine rather than
the app.

As executed on the development machine (macOS arm64, Playwright 1.62.1):

| Project | Mapped to | Genuine? |
|---|---|---|
| `chrome-141` | Google Chrome 152 (`channel: 'chrome'`, locally installed) | **alias** — same engine family (Blink), newer version |
| `chrome-140` | Playwright's bundled Chromium (≈152) | **alias** — Blink, newer version |
| `edge-141` | `channel: 'msedge'` | **not run** — Edge is not installed here; the project skips |
| `edge-140` | `channel: 'msedge'` | **not run** — same |
| `firefox-145` | Playwright's bundled Firefox 153 | **alias** — Gecko, newer version |
| `firefox-144` | Playwright's bundled Firefox 153 | **alias** — Gecko, newer version |
| `safari-26.1` | Playwright's bundled WebKit 26.5 | **alias** — WebKit, close to the pinned Safari 26.x |
| `safari-26.0` | Playwright's bundled WebKit 26.5 | **alias** — same |

So the honest statement is: **three engines** (Blink, Gecko, WebKit) pass the
VC-016 / VC-022 / VC-024 / VC-030 / VC-067 / VC-045 set at versions at or above
the pinned ones; **six of the eight named projects run**, all as engine
aliases; **two (Edge 141 and 140) are not covered here** and need a machine
with Microsoft Edge installed. Edge is Chromium-based, so the Blink result is
strong evidence — but it is evidence, not a run, and the config will not
pretend otherwise.

The WebKit run is what surfaced the respawn-URL bug described above; before
that fix, Safari genuinely could not satisfy post-Stop worker recovery.

# Repository Guidelines

- License is GPL-2.0-or-later; extensions.gnome.org rejects anything GPL-2.0 incompatible
- The icon must stay original artwork, never derived from a vendor's logo

- Keep `README.md` up to date after each change
- Make sure `bun run typecheck` and `bun run test` pass after significant changes
- Add or adjust tests when logic changes

# Layout

- `src/*.ts` sources, compiled by `tsc` into `lib/`
- `lib/` is the complete extension: compiled JavaScript, metadata, stylesheet,
  schema and the status line wrapper. Built, never committed
- `bin/claude-usage-statusline.js` runs under `gjs`, outside the shell process.
  extensions.gnome.org requires scripts to be GJS and rejects bundled executables
- `test/*.test.js` run under plain `gjs` against `lib/`

# Testing

Tests run without GNOME Shell. That constrains what may live where:

- `src/format.ts` and `src/profiles.ts` import no runtime module, so pure
  decisions belong there rather than in the indicator
- `src/store.ts` and `src/installer.ts` may import `Gio` and `GLib` only, never
  `resource:///org/gnome/shell/*`
- `src/indicator.ts`, `src/extension.ts` and `src/prefs.ts` are the only files
  allowed shell or Adw imports, and are not unit tested

Use the `check(label, actual, expected)` helper from `test/harness.js`, one line
per assertion. Prefer executing the real thing over asserting on a string:
`installer.test.js` runs the command it generated through `sh`.

# Code style

- Comments in English, explaining _why_ and never _what_
- `dprint fmt` decides layout
- Underscores as thousand separators, e.g. `1_000_000`
- camelCase and PascalCase rules apply to acronyms too
- Top-level functions do not use arrow syntax
- No shorthand property assignment in objects
- More than three parameters means an options object
- `strict` is on, along with `noUnusedLocals`, `noUncheckedIndexedAccess` and
  `noImplicitOverride`. Do not widen the config to make an error go away

# GNOME Shell specifics

- Everything created in the constructor is undone in `destroy()`: timeouts via
  `GLib.Source.remove`, handlers via `disconnect`
- No network access and no credential reads from the shell process
- No synchronous subprocess spawning, the shell blocks on it
- Never name a member after one a GObject already has, `notify` in particular

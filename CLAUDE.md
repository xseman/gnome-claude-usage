# Repository Guidelines

- License is GPL-2.0-or-later; extensions.gnome.org rejects anything GPL-2.0 incompatible
- The panel icon is Anthropic's mark; an extensions.gnome.org submission needs
  permission for it or an original replacement

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
- `src/store.ts`, `src/configDir.ts` and `src/usageClient.ts` may import `Gio`,
  `GLib` and `Soup` only, never `resource:///org/gnome/shell/*`
- `src/installer.ts` does synchronous file IO and is loaded by prefs only; the
  shell must never import it, shexli flags sync IO reachable from extension.js
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
- Network and credential reads happen only in `usageClient.ts`, only when the
  `live-fetch` setting is on, and the token is never refreshed or written back
- No synchronous subprocess spawning, the shell blocks on it
- Never name a member after one a GObject already has, `notify` in particular

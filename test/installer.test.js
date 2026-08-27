#!/usr/bin/env -S gjs -m
/**
 * Integration tests for src/lib/installer.js.
 *
 * Run with `gjs -m test/installer.test.js`. The installer rewrites a real
 * settings.json, so every case here works against throwaway directories, and
 * the command it generates is executed to prove the shell quoting holds.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
	inspect,
	install,
	readSettings,
	shellQuote,
	uninstall,
} from "../lib/installer.js";
import {
	check,
	report,
} from "./harness.js";

const root = GLib.dir_make_tmp("claude-usage-installer-XXXXXX");
const wrapper = GLib.build_filenamev([
	GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace("file://", ""))),
	"bin",
	"claude-usage-statusline",
]);

function makeConfig(name, contents) {
	const dir = GLib.build_filenamev([root, name]);
	GLib.mkdir_with_parents(dir, 0o755);

	if (contents !== null) {
		Gio.File.new_for_path(GLib.build_filenamev([dir, "settings.json"]))
			.replace_contents(
				new TextEncoder().encode(contents),
				null,
				false,
				Gio.FileCreateFlags.NONE,
				null,
			);
	}

	return dir;
}

check("shellQuote wraps a plain value", shellQuote("/home/me/.claude"), "'/home/me/.claude'");
check("shellQuote escapes single quotes", shellQuote("a'b"), `'a'\\''b'`);

// A config directory without settings.json is the common first install.
const fresh = makeConfig("fresh", null);
check("a fresh profile reports no hook", inspect(fresh).installed, false);

const freshResult = install(fresh, wrapper);
check("installs into a fresh profile", freshResult.ok, true);
check("a fresh profile has nothing to chain", freshResult.chain, "");
check("the hook is detected afterwards", inspect(fresh).installed, true);
check("the status line type is a command", readSettings(fresh).statusLine.type, "command");

// An existing status line must survive, quotes and all.
const existing = makeConfig(
	"existing",
	JSON.stringify({ statusLine: { type: "command", command: `sh -c 'cat > /dev/null; echo mine'` }, model: "opus" }, null, 2),
);

const existingResult = install(existing, wrapper);
check("installs alongside an existing status line", existingResult.ok, true);
check("returns the previous command", existingResult.chain, `sh -c 'cat > /dev/null; echo mine'`);
check("keeps unrelated settings", readSettings(existing).model, "opus");
check(
	"takes a one time backup",
	GLib.file_test(GLib.build_filenamev([existing, "settings.json.bak-claude-usage"]), GLib.FileTest.EXISTS),
	true,
);

// Installing twice must not nest the wrapper inside itself.
const before = readSettings(existing).statusLine.command;
const again = install(existing, wrapper);
check("installing twice is a no-op", readSettings(existing).statusLine.command, before);
check("installing twice still succeeds", again.ok, true);

// The generated command has to survive a real shell.
const command = readSettings(existing).statusLine.command;
const stateDir = GLib.build_filenamev([root, "state"]);
const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } });

const [, stdout, stderr, status] = GLib.spawn_sync(
	root,
	["sh", "-c", `printf %s ${shellQuote(payload)} | ${command}`],
	[`HOME=${root}`, `XDG_STATE_HOME=${stateDir}`, "PATH=/usr/bin:/bin"],
	GLib.SpawnFlags.SEARCH_PATH,
	null,
);

const output = new TextDecoder().decode(stdout).trim();
check("the generated command runs", status, 0);
check("stderr stays quiet", new TextDecoder().decode(stderr).trim(), "");
check("the chained status line still runs", output, "mine");

const slug = existing.replace(/-/g, "--").replace(/\//g, "-");
const written = GLib.build_filenamev([stateDir, "claude-usage", `${slug}.json`]);
check("the payload reaches the state directory", GLib.file_test(written, GLib.FileTest.EXISTS), true);

// Uninstalling restores exactly what was there.
check("uninstall succeeds", uninstall(existing, existingResult.chain).ok, true);
check(
	"uninstall restores the previous command",
	readSettings(existing).statusLine.command,
	`sh -c 'cat > /dev/null; echo mine'`,
);

check("uninstall without a chain removes the status line", uninstall(fresh, "").ok, true);
check("the status line is gone", readSettings(fresh).statusLine, undefined);

// Corrupt settings must fail loudly rather than clobber the file.
const broken = makeConfig("broken", "{ not json");
check("a corrupt profile is not readable", inspect(broken).readable, false);
check("installing into a corrupt profile fails", install(broken, wrapper).ok, false);

GLib.spawn_command_line_sync(`rm -rf ${root}`);

report();

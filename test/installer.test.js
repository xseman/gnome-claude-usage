#!/usr/bin/env -S gjs -m
/**
 * Integration tests for src/installer.ts.
 *
 * Run with `gjs -m test/installer.test.js`. The installer rewrites real
 * settings files, so every case works against throwaway directories, and the
 * command it generates is executed to prove the shell quoting holds.
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

function makeConfig(name, files) {
	const dir = GLib.build_filenamev([root, name]);
	GLib.mkdir_with_parents(dir, 0o755);

	for (const [file, contents] of Object.entries(files)) {
		Gio.File.new_for_path(GLib.build_filenamev([dir, file])).replace_contents(
			new TextEncoder().encode(contents),
			null,
			false,
			Gio.FileCreateFlags.NONE,
			null,
		);
	}

	return dir;
}

function statusLine(command) {
	return JSON.stringify({ statusLine: { type: "command", command: command } }, null, 2);
}

check("shellQuote wraps a plain value", shellQuote("/home/me/.claude"), "'/home/me/.claude'");
check("shellQuote escapes single quotes", shellQuote("a'b"), `'a'\\''b'`);

// A config directory without settings is the common first install.
const fresh = makeConfig("fresh", {});
check("a fresh profile has no hook", inspect(fresh).installedIn, null);
check("a fresh profile has no foreign status line", inspect(fresh).foreign, null);
check("a fresh profile targets settings.json", inspect(fresh).target, "settings.json");

const freshResult = install(fresh, wrapper);
check("installs into a fresh profile", freshResult.ok, true);
check("a fresh profile has nothing to chain", freshResult.chain, "");
check("the hook is detected afterwards", inspect(fresh).installedIn, "settings.json");

// An existing status line must survive, quotes and all.
const existing = makeConfig("existing", {
	"settings.json": JSON.stringify(
		{ statusLine: { type: "command", command: `sh -c 'cat > /dev/null; echo mine'` }, model: "opus" },
		null,
		2,
	),
});

check("an existing status line is reported as foreign", inspect(existing).foreign.file, "settings.json");

const existingResult = install(existing, wrapper);
check("installs alongside an existing status line", existingResult.ok, true);
check("returns the previous command", existingResult.chain, `sh -c 'cat > /dev/null; echo mine'`);
check("keeps unrelated settings", readSettings(existing, "settings.json").model, "opus");
check(
	"takes a one time backup",
	GLib.file_test(
		GLib.build_filenamev([existing, "settings.json.bak-claude-usage"]),
		GLib.FileTest.EXISTS,
	),
	true,
);
check("nothing is foreign once installed", inspect(existing).foreign, null);

// Installing twice must not nest the wrapper inside itself.
const before = readSettings(existing, "settings.json").statusLine.command;
check("installing twice succeeds", install(existing, wrapper).ok, true);
check(
	"installing twice is a no-op",
	readSettings(existing, "settings.json").statusLine.command,
	before,
);

// settings.local.json outranks settings.json, so writing to the lower file
// would install a hook Claude Code never runs.
const shadowed = makeConfig("shadowed", {
	"settings.json": statusLine("echo lower"),
	"settings.local.json": statusLine("echo higher"),
});

check("the higher precedence file is the target", inspect(shadowed).target, "settings.local.json");
check("its status line is the foreign one", inspect(shadowed).foreign.file, "settings.local.json");
check("installing succeeds", install(shadowed, wrapper).ok, true);
check(
	"the hook lands in the file Claude Code obeys",
	inspect(shadowed).installedIn,
	"settings.local.json",
);
check(
	"the lower file is left alone",
	readSettings(shadowed, "settings.json").statusLine.command,
	"echo lower",
);
check(
	"the higher command is chained, not overwritten",
	readSettings(shadowed, "settings.local.json").statusLine.command.includes("echo higher"),
	true,
);

// The generated command has to survive a real shell.
const command = readSettings(existing, "settings.json").statusLine.command;
const state = GLib.build_filenamev([root, "state"]);
const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } });

const [, stdout, stderr, status] = GLib.spawn_sync(
	root,
	["sh", "-c", `printf %s ${shellQuote(payload)} | ${command}`],
	[`HOME=${root}`, `XDG_STATE_HOME=${state}`, "PATH=/usr/bin:/bin"],
	GLib.SpawnFlags.SEARCH_PATH,
	null,
);

check("the generated command runs", status, 0);
check("stderr stays quiet", new TextDecoder().decode(stderr).trim(), "");
check("the chained status line still runs", new TextDecoder().decode(stdout).trim(), "mine");

const slug = existing.replace(/-/g, "--").replace(/\//g, "-");
check(
	"the payload reaches the state directory",
	GLib.file_test(GLib.build_filenamev([state, "claude-usage", `${slug}.json`]), GLib.FileTest.EXISTS),
	true,
);

// Uninstalling restores exactly what was there, in the file it was written to.
check("uninstall succeeds", uninstall(existing, existingResult.chain).ok, true);
check(
	"uninstall restores the previous command",
	readSettings(existing, "settings.json").statusLine.command,
	`sh -c 'cat > /dev/null; echo mine'`,
);
check("uninstall without a chain removes the status line", uninstall(fresh, "").ok, true);
check("the status line is gone", readSettings(fresh, "settings.json").statusLine, undefined);
check("uninstalling twice is harmless", uninstall(fresh, "").ok, true);

// Corrupt settings must fail loudly rather than clobber the file.
const broken = makeConfig("broken", { "settings.json": "{ not json" });
check("a corrupt profile is not readable", inspect(broken).readable, false);
check("installing into a corrupt profile fails", install(broken, wrapper).ok, false);
check("the corrupt file is untouched", readSettings(broken, "settings.json"), null);

GLib.spawn_command_line_sync(`rm -rf ${root}`);

report();

#!/usr/bin/env -S gjs -m
/**
 * Integration tests for src/lib/store.js.
 *
 * Run with `gjs -m test/store.test.js`. The store only imports Gio, GLib and
 * GObject, so it runs outside GNOME Shell against a real temporary directory.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { Store } from "../lib/store.js";
import {
	check,
	report,
} from "./harness.js";

function write(dir, name, contents) {
	const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
	file.replace_contents(
		new TextEncoder().encode(contents),
		null,
		false,
		Gio.FileCreateFlags.NONE,
		null,
	);
}

function remove(dir, name) {
	Gio.File.new_for_path(GLib.build_filenamev([dir, name])).delete(null);
}

const root = GLib.dir_make_tmp("claude-usage-XXXXXX");
const stateDir = GLib.build_filenamev([root, "state"]);

function payload(percent) {
	return JSON.stringify({
		model: { display_name: "Opus 5" },
		rate_limits: { five_hour: { used_percentage: percent, resets_at: 1_787_800_000 } },
	});
}

// The store creates its directory, so it can be pointed at one that is missing.
const store = new Store(stateDir);
check("creates a missing state directory", GLib.file_test(stateDir, GLib.FileTest.IS_DIR), true);
check("starts empty", store.get("/home/me/.claude"), null);

write(stateDir, "-home-me-.claude.json", payload(43.2));
write(stateDir, "-home-me-.claude--work.json", payload(9));
write(stateDir, "-home-me-.claude--broken.json", "{ this is not json");
write(stateDir, "ignored.txt", payload(1));

check("refresh reports a change", await store.refresh(), true);
check("reads valid payloads", store.get("/home/me/.claude") !== null, true);
check("ignores non json files", store.get("/home/me/ignored"), null);
check("skips corrupt payloads", store.get("/home/me/.claude-broken"), null);
check(
	"looks up a plain config dir",
	store.get("/home/me/.claude").payload.rate_limits.five_hour.used_percentage,
	43.2,
);

// Dashes in the directory name are exactly the case a reverse mapping breaks on.
check("keeps dashed directories distinct", store.get("/home/me/.claude-work") !== null, true);
check("does not confuse a dashed dir with a nested one", store.get("/home/me/.claude/work"), null);
check("records a modification time", store.get("/home/me/.claude").updatedAt > 0, true);

check("an idle refresh is a no-op", await store.refresh(), false);

// Size is part of the stamp, so a same-second rewrite is still picked up.
write(stateDir, "-home-me-.claude.json", payload(77.25));
check("notices a rewritten payload", await store.refresh(), true);
check(
	"serves the rewritten value",
	store.get("/home/me/.claude").payload.rate_limits.five_hour.used_percentage,
	77.25,
);

remove(stateDir, "-home-me-.claude--work.json");
check("notices a removed payload", await store.refresh(), true);
check("forgets the removed profile", store.get("/home/me/.claude-work"), null);

store.destroy();
check("destroy clears the entries", store.get("/home/me/.claude"), null);

GLib.spawn_command_line_sync(`rm -rf ${root}`);

report();

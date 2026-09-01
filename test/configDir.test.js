#!/usr/bin/env -S gjs -m
/**
 * Integration tests for src/configDir.ts, against throwaway directories. HOME
 * is pointed at one of them so discovery scans a controlled tree.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
	discoverConfigDirs,
	hookInstalled,
	readCredentials,
	readJson,
} from "../lib/configDir.js";
import {
	check,
	report,
} from "./harness.js";

const home = GLib.dir_make_tmp("claude-usage-home-XXXXXX");
GLib.setenv("HOME", home, true);

function write(dir, name, body) {
	GLib.mkdir_with_parents(dir, 0o700);
	Gio.File.new_for_path(GLib.build_filenamev([dir, name])).replace_contents(
		new TextEncoder().encode(body),
		null,
		false,
		Gio.FileCreateFlags.NONE,
		null,
	);
}

const credentials = JSON.stringify({
	claudeAiOauth: {
		accessToken: "sk-ant-oat01-test",
		expiresAt: 1_787_842_120_290,
		subscriptionType: "max",
		rateLimitTier: "default_claude_max_5x",
	},
});

write(`${home}/.claude`, ".credentials.json", credentials);
write(`${home}/.claude`, "settings.json", `{"statusLine":{"type":"command","command":"gjs -m x/claude-usage-statusline.js"}}`);
write(`${home}/.claude-work`, ".credentials.json", credentials);
write(`${home}/.claude-work`, "settings.local.json", `{"statusLine":{"type":"command","command":"echo other"}}`);
write(`${home}/.claude-empty`, "settings.json", "{}");
write(`${home}/.claude-broken`, ".credentials.json", "{ not json");
write(`${home}/.config`, "x", "");

check("readJson parses a file", (await readJson(`${home}/.claude/settings.json`)).statusLine.type, "command");
check("readJson yields null for a missing file", await readJson(`${home}/nope.json`), null);
check("readJson yields null for corrupt JSON", await readJson(`${home}/.claude-broken/.credentials.json`), null);

check("hookInstalled sees the wrapper", await hookInstalled(`${home}/.claude`), true);
check("hookInstalled ignores a foreign status line", await hookInstalled(`${home}/.claude-work`), false);
check("hookInstalled is false without settings", await hookInstalled(`${home}/.claude-empty`), false);

const read = await readCredentials(`${home}/.claude`);
check("readCredentials reads the plan", read.subscriptionType, "max");
check("readCredentials reads the tier", read.rateLimitTier, "default_claude_max_5x");
check("readCredentials reads the token", read.accessToken, "sk-ant-oat01-test");
check("readCredentials reads expiry", read.expiresAt, 1_787_842_120_290);
check("readCredentials is null without a login", await readCredentials(`${home}/.claude-empty`), null);
check("readCredentials is null for corrupt JSON", await readCredentials(`${home}/.claude-broken`), null);

check(
	"discoverConfigDirs finds only directories with a login",
	(await discoverConfigDirs()).map((dir) => dir.replace(home, "~")),
	["~/.claude", "~/.claude-work"],
);

GLib.spawn_command_line_sync(`rm -rf ${home}`);
report();

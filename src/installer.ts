import Gio from "gi://Gio";
import GLib from "gi://GLib";

/**
 * Installs the status line wrapper into a Claude Code config directory.
 *
 * Claude Code only hands the rate limit payload to the command configured as
 * `statusLine`, so a profile stays dark until its settings.json points at the
 * wrapper. Whatever status line was configured before is preserved and chained,
 * never dropped.
 */

/** The parts of a Claude Code settings.json this module touches. */
interface ClaudeSettings {
	statusLine?: { type: string; command: string; };
	[key: string]: unknown;
}

/** What a profile's settings.json currently says. */
export interface HookState {
	exists: boolean;
	readable: boolean;
	installed: boolean;
}

export interface InstallResult {
	ok: boolean;
	error: string;
	/** Command that was configured before, to restore on uninstall. */
	chain: string;
}

export interface UninstallResult {
	ok: boolean;
	error: string;
}

/** Substring that identifies a command as ours. */
const MARKER = "claude-usage-statusline";

/** Suffix of the one-time backup taken before the first edit. */
const BACKUP_SUFFIX = ".bak-claude-usage";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Quote a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Current state of a profile: whether its config directory exists, whether its
 * settings parse and whether the configured status line is ours.
 */
export function inspect(configDir: string): HookState {
	const exists = GLib.file_test(configDir, GLib.FileTest.IS_DIR);
	const settings = readSettings(configDir);

	return {
		exists: exists,
		readable: settings !== null,
		installed: commandOf(settings).includes(MARKER),
	};
}

/**
 * Point the profile's status line at the wrapper.
 *
 * Returns the command that was configured before, so it can be restored on
 * uninstall. Installing twice is a no-op rather than a nested chain.
 */
export function install(configDir: string, wrapperPath: string): InstallResult {
	const settings = readSettings(configDir);
	if (settings === null) {
		return { ok: false, error: `${settingsPath(configDir)} is not readable JSON`, chain: "" };
	}

	const previous = commandOf(settings);
	if (previous.includes(MARKER)) {
		return { ok: true, error: "", chain: "" };
	}

	const parts = [`CLAUDE_USAGE_DIR=${shellQuote(configDir)}`];
	if (previous !== "") {
		parts.push(`CLAUDE_USAGE_CHAIN=${shellQuote(previous)}`);
	}
	parts.push(shellQuote(wrapperPath));

	settings.statusLine = { type: "command", command: parts.join(" ") };

	const error = writeSettings(configDir, settings);

	return { ok: error === "", error: error, chain: previous };
}

/**
 * Restore the profile's status line. The command recorded at install time wins;
 * without one the status line is removed entirely.
 */
export function uninstall(configDir: string, chain: string): UninstallResult {
	const settings = readSettings(configDir);
	if (settings === null) {
		return { ok: false, error: `${settingsPath(configDir)} is not readable JSON` };
	}

	if (chain !== "") {
		settings.statusLine = { type: "command", command: chain };
	} else {
		delete settings.statusLine;
	}

	const error = writeSettings(configDir, settings);

	return { ok: error === "", error: error };
}

/** Parse a profile's settings.json. A missing file reads as an empty object. */
export function readSettings(configDir: string): ClaudeSettings | null {
	const file = Gio.File.new_for_path(settingsPath(configDir));

	let contents: string;
	try {
		const [ok, bytes] = file.load_contents(null);
		if (!ok) {
			return null;
		}

		contents = decoder.decode(bytes);
	} catch (error) {
		const missing = error instanceof GLib.Error
			&& error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);

		return missing ? {} : null;
	}

	try {
		const parsed: unknown = JSON.parse(contents);
		return parsed !== null && typeof parsed === "object" ? parsed as ClaudeSettings : null;
	} catch {
		return null;
	}
}

function settingsPath(configDir: string): string {
	return GLib.build_filenamev([configDir, "settings.json"]);
}

function commandOf(settings: ClaudeSettings | null): string {
	return typeof settings?.statusLine?.command === "string" ? settings.statusLine.command : "";
}

function writeSettings(configDir: string, settings: ClaudeSettings): string {
	const file = Gio.File.new_for_path(settingsPath(configDir));

	// Keep one pristine copy of whatever was there before the first edit.
	const backup = Gio.File.new_for_path(settingsPath(configDir) + BACKUP_SUFFIX);
	if (file.query_exists(null) && !backup.query_exists(null)) {
		try {
			file.copy(backup, Gio.FileCopyFlags.NONE, null, null);
		} catch (error) {
			return `backup failed: ${messageOf(error)}`;
		}
	}

	try {
		file.replace_contents(
			encoder.encode(`${JSON.stringify(settings, null, 2)}\n`),
			null,
			false,
			Gio.FileCreateFlags.NONE,
			null,
		);
	} catch (error) {
		return messageOf(error);
	}

	return "";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

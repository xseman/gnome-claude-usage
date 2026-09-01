import Gio from "gi://Gio";
import GLib from "gi://GLib";

/**
 * Installs the status line wrapper into a Claude Code config directory.
 *
 * Claude Code only hands the rate limit payload to the command configured as
 * `statusLine`, so a profile stays dark until its settings point at the
 * wrapper. Whatever status line was configured before is preserved and chained,
 * never dropped.
 */

/**
 * Settings files a config directory can hold, highest precedence first.
 *
 * Claude Code merges several sources and `settings.local.json` outranks
 * `settings.json`. Writing to the lower one while the higher one defines a
 * status line would install a hook that silently never runs, so the wrapper
 * goes into whichever file already owns the status line.
 */
const SETTINGS_FILES = [
	"settings.local.json",
	"settings.json",
] as const;

/** Substring that identifies a command as ours. */
const MARKER = "claude-usage-statusline";

/** Suffix of the one-time backup taken before the first edit. */
const BACKUP_SUFFIX = ".bak-claude-usage";

/** The parts of a Claude Code settings file this module touches. */
interface ClaudeSettings {
	statusLine?: { type: string; command: string; };
	[key: string]: unknown;
}

/** What a profile's settings currently say. */
export interface HookState {
	exists: boolean;
	readable: boolean;
	/** Set when the wrapper is installed, to the file holding it. */
	installedIn: string | null;
	/** A status line this extension did not write, and the file holding it. */
	foreign: { file: string; command: string; } | null;
	/** File `install` would write to. */
	target: string;
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

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Quote a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Look at every settings file a profile can have and report what is there:
 * whether the wrapper is installed, whether some other status line already
 * exists, and which file an install would touch.
 */
export function inspect(configDir: string): HookState {
	const exists = GLib.file_test(configDir, GLib.FileTest.IS_DIR);
	let readable = true;
	let installedIn: string | null = null;
	let foreign: { file: string; command: string; } | null = null;
	let owner: string | null = null;

	for (const file of SETTINGS_FILES) {
		const settings = readSettings(configDir, file);
		if (settings === null) {
			readable = false;
			continue;
		}

		const command = commandOf(settings);
		if (command === "") {
			continue;
		}

		// The first file with a status line is the one Claude Code obeys.
		owner ??= file;

		if (command.includes(MARKER)) {
			installedIn ??= file;
		} else {
			foreign ??= { file: file, command: command };
		}
	}

	return {
		exists: exists,
		readable: readable,
		installedIn: installedIn,
		foreign: foreign,
		target: owner ?? "settings.json",
	};
}

/**
 * Point the profile's status line at the wrapper, keeping any command that was
 * already there as a chained one. Installing twice is a no-op rather than a
 * nested chain.
 */
export function install(configDir: string, wrapperPath: string): InstallResult {
	const state = inspect(configDir);

	if (state.installedIn !== null) {
		return { ok: true, error: "", chain: "" };
	}

	const settings = readSettings(configDir, state.target);
	if (settings === null) {
		return {
			ok: false,
			error: `${state.target} is not readable JSON`,
			chain: "",
		};
	}

	const previous = commandOf(settings);
	const parts = [`CLAUDE_USAGE_DIR=${shellQuote(configDir)}`];
	if (previous !== "") {
		parts.push(`CLAUDE_USAGE_CHAIN=${shellQuote(previous)}`);
	}
	parts.push(shellQuote(wrapperPath));

	settings.statusLine = { type: "command", command: parts.join(" ") };

	const error = writeSettings(configDir, state.target, settings);

	return { ok: error === "", error: error, chain: previous };
}

/**
 * Restore the profile's status line in whichever file the wrapper ended up in.
 * The command recorded at install time wins; without one the status line is
 * removed entirely.
 */
export function uninstall(configDir: string, chain: string): UninstallResult {
	const file = inspect(configDir).installedIn;
	if (file === null) {
		return { ok: true, error: "" };
	}

	const settings = readSettings(configDir, file);
	if (settings === null) {
		return { ok: false, error: `${file} is not readable JSON` };
	}

	if (chain !== "") {
		settings.statusLine = { type: "command", command: chain };
	} else {
		delete settings.statusLine;
	}

	const error = writeSettings(configDir, file, settings);

	return { ok: error === "", error: error };
}

/** Parse one settings file. A missing file reads as an empty object. */
export function readSettings(configDir: string, file: string): ClaudeSettings | null {
	const path = GLib.build_filenamev([configDir, file]);

	let contents: string;
	try {
		const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
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

function commandOf(settings: ClaudeSettings): string {
	return typeof settings.statusLine?.command === "string" ? settings.statusLine.command : "";
}

function writeSettings(configDir: string, name: string, settings: ClaudeSettings): string {
	const path = GLib.build_filenamev([configDir, name]);
	const file = Gio.File.new_for_path(path);

	// Keep one pristine copy of whatever was there before the first edit.
	const backup = Gio.File.new_for_path(path + BACKUP_SUFFIX);
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

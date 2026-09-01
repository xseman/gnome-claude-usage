import Gio from "gi://Gio";
import GLib from "gi://GLib";

/**
 * Read-only, asynchronous helpers over a Claude Code config directory: the
 * value CLAUDE_CONFIG_DIR would be set to. Safe to import from the shell
 * process, which must never block on a file. Anything that writes lives in
 * installer.ts, which only the preferences dialog loads.
 */

// Promise-returning variants of the async Gio calls used below.
Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "enumerate_children_async");
Gio._promisify(Gio.FileEnumerator.prototype, "next_files_async");

/** Substring that identifies a statusLine command as ours. */
export const HOOK_MARKER = "claude-usage-statusline";

/** Settings files Claude Code reads from a config directory, highest precedence first. */
export const SETTINGS_FILES = [
	"settings.local.json",
	"settings.json",
] as const;

/** What Claude Code leaves in .credentials.json after a subscription login. */
export interface Credentials {
	subscriptionType: string | null;
	rateLimitTier: string | null;
	accessToken: string | null;
	/** Epoch milliseconds. */
	expiresAt: number | null;
}

/** Parse a JSON file, or null when it is missing or not an object. */
export async function readJson(path: string): Promise<Record<string, unknown> | null> {
	let text: string;
	try {
		const [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
		text = new TextDecoder().decode(contents);
	} catch {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object"
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

/** Whether the status line wrapper is installed in any settings file of a profile. */
export async function hookInstalled(configDir: string): Promise<boolean> {
	for (const name of SETTINGS_FILES) {
		const settings = await readJson(GLib.build_filenamev([configDir, name]));
		const statusLine = settings?.["statusLine"] as { command?: unknown; } | undefined;

		if (typeof statusLine?.command === "string" && statusLine.command.includes(HOOK_MARKER)) {
			return true;
		}
	}

	return false;
}

/**
 * The subscription and token Claude Code stored for a profile. Nothing here is
 * ever written back: the token is refreshed by Claude Code alone, so two
 * processes never race over the refresh token.
 */
export async function readCredentials(configDir: string): Promise<Credentials | null> {
	const file = await readJson(GLib.build_filenamev([configDir, ".credentials.json"]));
	const oauth = file?.["claudeAiOauth"] as Record<string, unknown> | undefined;
	if (!oauth) {
		return null;
	}

	const text = (key: string): string | null => {
		return typeof oauth[key] === "string" ? oauth[key] as string : null;
	};

	return {
		subscriptionType: text("subscriptionType"),
		rateLimitTier: text("rateLimitTier"),
		accessToken: text("accessToken"),
		expiresAt: typeof oauth["expiresAt"] === "number" ? oauth["expiresAt"] as number : null,
	};
}

/**
 * Config directories a Claude Code login has left in the home directory:
 * `~/.claude` and any `~/.claude-*` sibling, which is the CLAUDE_CONFIG_DIR
 * convention for running several accounts. Only directories holding a
 * .credentials.json count, so an empty leftover is not offered as a profile.
 */
export async function discoverConfigDirs(): Promise<string[]> {
	const home = Gio.File.new_for_path(GLib.get_home_dir());
	const found: string[] = [];

	let enumerator: Gio.FileEnumerator;
	try {
		enumerator = await home.enumerate_children_async(
			"standard::name,standard::type",
			Gio.FileQueryInfoFlags.NONE,
			GLib.PRIORITY_DEFAULT,
			null,
		);
	} catch {
		return found;
	}

	for (;;) {
		const batch = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
		if (batch.length === 0) {
			break;
		}

		for (const info of batch) {
			const name = info.get_name();
			if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
				continue;
			}

			if (name !== ".claude" && !name.startsWith(".claude-")) {
				continue;
			}

			const dir = home.get_child(name).get_path();
			if (dir !== null && await readCredentials(dir) !== null) {
				found.push(dir);
			}
		}
	}

	enumerator.close(null);

	return found.sort();
}

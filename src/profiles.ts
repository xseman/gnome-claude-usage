import type Gio from "gi://Gio";

/**
 * Profile list persistence.
 *
 * GSettings has no dictionary type, so the list lives as an array of JSON
 * strings. Both the indicator and the preferences dialog go through here so the
 * shape stays in one place.
 */

/** A Claude Code config directory the panel should report on. */
export interface Profile {
	/** Identifies the profile; the value CLAUDE_CONFIG_DIR would be set to. */
	dir: string;
	enabled: boolean;
	/** Status line command the profile had before the wrapper was installed. */
	chain: string;
}

/** Read the configured profiles, dropping entries that no longer parse. */
export function readProfiles(settings: Gio.Settings): Profile[] {
	const profiles: Profile[] = [];

	for (const raw of settings.get_strv("profiles")) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}

		if (typeof parsed?.dir !== "string" || parsed.dir === "") {
			continue;
		}

		profiles.push({
			dir: parsed.dir,
			enabled: parsed.enabled !== false,
			chain: typeof parsed.chain === "string" ? parsed.chain : "",
		});
	}

	return profiles;
}

/** Persist the profile list. */
export function writeProfiles(settings: Gio.Settings, profiles: Profile[]): void {
	settings.set_strv(
		"profiles",
		profiles.map((profile) => {
			return JSON.stringify(profile);
		}),
	);
}

/**
 * Display name for a profile: the config directory's own name, without the
 * leading dot that hides it. `~/.claude-work` reads as `claude-work`.
 */
export function profileName(dir: string): string {
	const parts = dir.split("/").filter((part) => {
		return part !== "";
	});

	return (parts.at(-1) ?? dir).replace(/^\./, "");
}

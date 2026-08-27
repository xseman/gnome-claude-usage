import type Gio from "gi://Gio";

/**
 * Profile list persistence.
 *
 * GSettings has no dictionary type, so the list lives as an array of JSON
 * strings. Both the indicator and the preferences dialog go through here so the
 * shape stays in one place.
 *
 * A profile is identified by its config directory; `chain` holds the status
 * line command it had before the wrapper was installed, so uninstalling puts
 * back exactly what was there.
 */

/** A Claude Code config directory the panel should report on. */
export interface Profile {
	name: string;
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
			name: typeof parsed.name === "string" && parsed.name !== ""
				? parsed.name
				: basename(parsed.dir),
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

/** Default display name for a config directory. */
export function basename(dir: string): string {
	const parts = dir.split("/").filter((part) => {
		return part !== "";
	});

	return parts.at(-1) ?? dir;
}

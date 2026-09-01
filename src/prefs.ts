import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
	type HookState,
	inspect,
	install,
	uninstall,
} from "./installer.js";
import {
	profileName,
	readProfiles,
	writeProfiles,
} from "./profiles.js";
import { stateDir } from "./store.js";

/** Value stored in GSettings paired with the label shown for it. */
type Choice = [string, string];

interface SpinOptions {
	min: number;
	max: number;
	subtitle: string;
}

/** Strategies the panel button can follow, ahead of the pinnable profiles. */
const PANEL_STRATEGIES: Choice[] = [
	["highest", "Closest to its limit"],
	["active", "Most recently active"],
	["all", "All profiles side by side"],
];

const PANEL_LIMITS: Choice[] = [
	["five-hour", "5 hour window"],
	["seven-day", "7 day window"],
	["highest", "Whichever is highest"],
];

/** State of one open preferences window. */
interface Context {
	settings: Gio.Settings;
	wrapper: string;
	group: Adw.PreferencesGroup | null;
	rows: Adw.PreferencesRow[];
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
	// GNOME Shell awaits this hook, so the base type declares it async. The body
	// has nothing to wait for and still runs to completion synchronously.
	override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
		// Everything scoped to this window lives on a context the builders
		// share, never on the extension object, so closing the window drops it.
		const ctx: Context = {
			settings: this.getSettings(),
			wrapper: GLib.build_filenamev([this.path, "bin", "claude-usage-statusline.js"]),
			group: null,
			rows: [],
		};

		window.add(profilesPage(ctx, window));
		window.add(panelPage(ctx));
	}
}
/* Profiles */

function profilesPage(ctx: Context, window: Adw.PreferencesWindow): Adw.PreferencesPage {
	const page = new Adw.PreferencesPage({
		title: "Profiles",
		icon_name: "system-users-symbolic",
	});

	ctx.group = new Adw.PreferencesGroup({
		title: "Profiles",
		description: "One entry per Claude Code config directory, the value "
			+ `CLAUDE_CONFIG_DIR would be set to. Only ${stateDir()} is read, `
			+ "never your credentials, and never the network.",
	});

	const add = new Gtk.Button({
		icon_name: "list-add-symbolic",
		tooltip_text: "Add a profile",
		valign: Gtk.Align.CENTER,
		css_classes: ["flat"],
	});
	add.connect("clicked", () => {
		chooseDirectory(ctx, window);
	});

	ctx.group.set_header_suffix(add);
	page.add(ctx.group);

	rebuildProfiles(ctx, window);

	return page;
}

function rebuildProfiles(ctx: Context, window: Adw.PreferencesWindow): void {
	for (const row of ctx.rows) {
		ctx.group?.remove(row);
	}

	ctx.rows = readProfiles(ctx.settings).map((profile, index) => {
		return profileRow(ctx, window, profile.dir, index);
	});

	if (ctx.rows.length === 0) {
		ctx.rows.push(
			new Adw.ActionRow({
				title: "No profiles yet",
				subtitle: "Add the config directory a Claude Code profile uses.",
			}),
		);
	}

	for (const row of ctx.rows) {
		ctx.group?.add(row);
	}
}

/** One row per profile: what it is, whether the hook is in, and the controls. */
function profileRow(
	ctx: Context,
	window: Adw.PreferencesWindow,
	dir: string,
	index: number,
): Adw.ActionRow {
	const state = inspect(dir);

	const row = new Adw.ActionRow({
		title: profileName(dir),
		subtitle: `${dir} · ${hookSummary(state)}`,
	});

	row.add_suffix(hookButton(ctx, window, dir, index, state));

	const enabled = new Gtk.Switch({
		active: readProfiles(ctx.settings)[index]?.enabled !== false,
		tooltip_text: "Show this profile in the panel",
		valign: Gtk.Align.CENTER,
	});
	enabled.connect("notify::active", () => {
		patch(ctx, index, { enabled: enabled.active });
	});
	row.add_suffix(enabled);

	const remove = new Gtk.Button({
		icon_name: "user-trash-symbolic",
		tooltip_text: "Remove this profile. Leaves the settings file untouched.",
		valign: Gtk.Align.CENTER,
		css_classes: ["flat"],
	});
	remove.connect("clicked", () => {
		const profiles = readProfiles(ctx.settings);
		profiles.splice(index, 1);
		writeProfiles(ctx.settings, profiles);
		rebuildProfiles(ctx, window);
	});
	row.add_suffix(remove);

	return row;
}

function hookButton(
	ctx: Context,
	window: Adw.PreferencesWindow,
	dir: string,
	index: number,
	state: HookState,
): Gtk.Widget {
	if (!state.exists || !state.readable) {
		return new Gtk.Label({
			label: state.exists ? "unreadable settings" : "missing directory",
			css_classes: ["dim-label"],
			valign: Gtk.Align.CENTER,
		});
	}

	const installed = state.installedIn !== null;

	const button = new Gtk.Button({
		label: installed ? "Remove hook" : "Install hook",
		tooltip_text: hookDetail(state),
		valign: Gtk.Align.CENTER,
		css_classes: installed ? ["flat"] : ["suggested-action"],
	});

	button.connect("clicked", () => {
		if (installed) {
			const result = uninstall(dir, readProfiles(ctx.settings)[index]?.chain ?? "");
			if (!result.ok) {
				window.add_toast(new Adw.Toast({ title: result.error }));
				return;
			}

			patch(ctx, index, { chain: "" });
		} else {
			const result = install(dir, ctx.wrapper);
			if (!result.ok) {
				window.add_toast(new Adw.Toast({ title: result.error }));
				return;
			}

			patch(ctx, index, { chain: result.chain });
		}

		rebuildProfiles(ctx, window);
	});

	return button;
}

function chooseDirectory(ctx: Context, window: Adw.PreferencesWindow): void {
	const dialog = new Gtk.FileDialog({
		title: "Select a Claude Code config directory",
		modal: true,
	});

	dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()));

	dialog.select_folder(window, null, (source, result) => {
		let dir: string | null;
		try {
			dir = (source as Gtk.FileDialog).select_folder_finish(result).get_path();
		} catch {
			// The dialog was dismissed.
			return;
		}

		if (dir === null) {
			return;
		}

		const profiles = readProfiles(ctx.settings);

		if (profiles.some((profile) => profile.dir === dir)) {
			window.add_toast(new Adw.Toast({ title: "That profile is already configured" }));
			return;
		}

		profiles.push({ dir: dir, enabled: true, chain: "" });
		writeProfiles(ctx.settings, profiles);
		rebuildProfiles(ctx, window);
	});
}

function patch(ctx: Context, index: number, changes: { enabled?: boolean; chain?: string; }): void {
	const profiles = readProfiles(ctx.settings);
	const profile = profiles[index];
	if (profile === undefined) {
		return;
	}

	profiles[index] = Object.assign(profile, changes);
	writeProfiles(ctx.settings, profiles);
}

/* Panel */

function panelPage(ctx: Context): Adw.PreferencesPage {
	const page = new Adw.PreferencesPage({
		title: "Panel",
		icon_name: "preferences-desktop-display-symbolic",
	});

	const pinnable: Choice[] = readProfiles(ctx.settings).map((profile) => {
		return [profile.dir, `Only ${profileName(profile.dir)}`];
	});

	const panel = new Adw.PreferencesGroup({ title: "Panel" });
	panel.add(combo(ctx, "Show", "panel-source", [...PANEL_STRATEGIES, ...pinnable]));
	panel.add(combo(ctx, "Limit", "panel-limit", PANEL_LIMITS));
	panel.add(toggle(ctx, "Hide without fresh data", "hide-when-stale", "Hide the button entirely instead of dimming it."));
	page.add(panel);

	const thresholds = new Adw.PreferencesGroup({
		title: "Thresholds",
		description: "Percentages at which usage is highlighted.",
	});
	thresholds.add(spin(ctx, "Warning", "warning-threshold", {
		min: 1,
		max: 100,
		subtitle: "",
	}));
	thresholds.add(spin(ctx, "Critical", "critical-threshold", {
		min: 1,
		max: 100,
		subtitle: "",
	}));
	thresholds.add(toggle(ctx, "Notify on crossing", "notify-threshold", "Send a notification when a profile crosses a threshold upwards."));
	page.add(thresholds);

	const timing = new Adw.PreferencesGroup({
		title: "Timing",
		description: "Payloads only arrive while a Claude Code session renders its "
			+ "status line, so data ages between sessions.",
	});
	timing.add(spin(ctx, "Refresh interval", "refresh-seconds", {
		min: 5,
		max: 600,
		subtitle: "seconds",
	}));
	timing.add(spin(ctx, "Data is stale after", "stale-after-minutes", {
		min: 1,
		max: 1440,
		subtitle: "minutes",
	}));
	page.add(timing);

	return page;
}

/* Building blocks */

function combo(ctx: Context, title: string, key: string, choices: Choice[]): Adw.ComboRow {
	const values = choices.map((choice) => choice[0]);

	const row = new Adw.ComboRow({
		title: title,
		model: Gtk.StringList.new(choices.map((choice) => choice[1])),
		selected: Math.max(0, values.indexOf(ctx.settings.get_string(key))),
	});

	row.connect("notify::selected", () => {
		const value = values[row.selected];
		if (value !== undefined) {
			ctx.settings.set_string(key, value);
		}
	});

	return row;
}

function toggle(ctx: Context, title: string, key: string, subtitle: string): Adw.SwitchRow {
	const row = new Adw.SwitchRow({ title: title, subtitle: subtitle });
	ctx.settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
	return row;
}

function spin(ctx: Context, title: string, key: string, options: SpinOptions): Adw.SpinRow {
	const row = new Adw.SpinRow({
		title: title,
		subtitle: options.subtitle,
		adjustment: new Gtk.Adjustment({
			lower: options.min,
			upper: options.max,
			step_increment: 1,
			page_increment: 10,
		}),
	});

	ctx.settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);

	return row;
}

function hookSummary(state: HookState): string {
	if (!state.exists) {
		return "directory does not exist";
	}

	if (!state.readable) {
		return "settings are not readable JSON";
	}

	if (state.installedIn !== null) {
		return `hook in ${state.installedIn}`;
	}

	return state.foreign === null
		? "no hook"
		: `no hook, ${state.foreign.file} sets its own status line`;
}

/** Spelled out on the button, where there is room for the whole story. */
function hookDetail(state: HookState): string {
	if (state.installedIn !== null) {
		return `Installed in ${state.installedIn}. Removing restores what was there before.`;
	}

	if (state.foreign !== null) {
		return `${state.foreign.file} already sets a status line:\n\n${state.foreign.command}`
			+ `\n\nInstalling writes to that same file and chains this command, so it keeps `
			+ `running. The original is backed up first.`;
	}

	return `Writes a statusLine entry to ${state.target}. `
		+ "Until then this profile reports nothing.";
}

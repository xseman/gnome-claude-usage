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

export default class ClaudeUsagePreferences extends ExtensionPreferences {
	private settings!: Gio.Settings;
	private wrapper!: string;
	private group!: Adw.PreferencesGroup;
	private rows: Adw.PreferencesRow[] = [];

	// GNOME Shell awaits this hook, so the base type declares it async. The body
	// has nothing to wait for and still runs to completion synchronously.
	override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
		this.settings = this.getSettings();
		this.wrapper = GLib.build_filenamev([this.path, "bin", "claude-usage-statusline"]);

		window.add(this.profilesPage(window));
		window.add(this.panelPage());
	}

	/* Profiles */

	private profilesPage(window: Adw.PreferencesWindow): Adw.PreferencesPage {
		const page = new Adw.PreferencesPage({
			title: "Profiles",
			icon_name: "system-users-symbolic",
		});

		this.group = new Adw.PreferencesGroup({
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
			this.chooseDirectory(window);
		});

		this.group.set_header_suffix(add);
		page.add(this.group);

		this.rebuildProfiles(window);

		return page;
	}

	private rebuildProfiles(window: Adw.PreferencesWindow): void {
		for (const row of this.rows) {
			this.group.remove(row);
		}

		this.rows = readProfiles(this.settings).map((profile, index) => {
			return this.profileRow(window, profile.dir, index);
		});

		if (this.rows.length === 0) {
			this.rows.push(
				new Adw.ActionRow({
					title: "No profiles yet",
					subtitle: "Add the config directory a Claude Code profile uses.",
				}),
			);
		}

		for (const row of this.rows) {
			this.group.add(row);
		}
	}

	/** One row per profile: what it is, whether the hook is in, and the controls. */
	private profileRow(
		window: Adw.PreferencesWindow,
		dir: string,
		index: number,
	): Adw.ActionRow {
		const state = inspect(dir);

		const row = new Adw.ActionRow({
			title: profileName(dir),
			subtitle: `${dir} · ${hookSummary(state)}`,
		});

		row.add_suffix(this.hookButton(window, dir, index, state));

		const enabled = new Gtk.Switch({
			active: readProfiles(this.settings)[index]?.enabled !== false,
			tooltip_text: "Show this profile in the panel",
			valign: Gtk.Align.CENTER,
		});
		enabled.connect("notify::active", () => {
			this.patch(index, { enabled: enabled.active });
		});
		row.add_suffix(enabled);

		const remove = new Gtk.Button({
			icon_name: "user-trash-symbolic",
			tooltip_text: "Remove this profile. Leaves the settings file untouched.",
			valign: Gtk.Align.CENTER,
			css_classes: ["flat"],
		});
		remove.connect("clicked", () => {
			const profiles = readProfiles(this.settings);
			profiles.splice(index, 1);
			writeProfiles(this.settings, profiles);
			this.rebuildProfiles(window);
		});
		row.add_suffix(remove);

		return row;
	}

	private hookButton(
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
				const result = uninstall(dir, readProfiles(this.settings)[index]?.chain ?? "");
				if (!result.ok) {
					window.add_toast(new Adw.Toast({ title: result.error }));
					return;
				}

				this.patch(index, { chain: "" });
			} else {
				const result = install(dir, this.wrapper);
				if (!result.ok) {
					window.add_toast(new Adw.Toast({ title: result.error }));
					return;
				}

				this.patch(index, { chain: result.chain });
			}

			this.rebuildProfiles(window);
		});

		return button;
	}

	private chooseDirectory(window: Adw.PreferencesWindow): void {
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

			const profiles = readProfiles(this.settings);

			if (profiles.some((profile) => profile.dir === dir)) {
				window.add_toast(new Adw.Toast({ title: "That profile is already configured" }));
				return;
			}

			profiles.push({ dir: dir, enabled: true, chain: "" });
			writeProfiles(this.settings, profiles);
			this.rebuildProfiles(window);
		});
	}

	private patch(index: number, changes: { enabled?: boolean; chain?: string; }): void {
		const profiles = readProfiles(this.settings);
		const profile = profiles[index];
		if (profile === undefined) {
			return;
		}

		profiles[index] = Object.assign(profile, changes);
		writeProfiles(this.settings, profiles);
	}

	/* Panel */

	private panelPage(): Adw.PreferencesPage {
		const page = new Adw.PreferencesPage({
			title: "Panel",
			icon_name: "preferences-desktop-display-symbolic",
		});

		const pinnable: Choice[] = readProfiles(this.settings).map((profile) => {
			return [profile.dir, `Only ${profileName(profile.dir)}`];
		});

		const panel = new Adw.PreferencesGroup({ title: "Panel" });
		panel.add(this.combo("Show", "panel-source", [...PANEL_STRATEGIES, ...pinnable]));
		panel.add(this.combo("Limit", "panel-limit", PANEL_LIMITS));
		panel.add(this.toggle(
			"Hide without fresh data",
			"hide-when-stale",
			"Hide the button entirely instead of dimming it.",
		));
		page.add(panel);

		const thresholds = new Adw.PreferencesGroup({
			title: "Thresholds",
			description: "Percentages at which usage is highlighted.",
		});
		thresholds.add(this.spin("Warning", "warning-threshold", {
			min: 1,
			max: 100,
			subtitle: "",
		}));
		thresholds.add(this.spin("Critical", "critical-threshold", {
			min: 1,
			max: 100,
			subtitle: "",
		}));
		thresholds.add(this.toggle(
			"Notify on crossing",
			"notify-threshold",
			"Send a notification when a profile crosses a threshold upwards.",
		));
		page.add(thresholds);

		const timing = new Adw.PreferencesGroup({
			title: "Timing",
			description: "Payloads only arrive while a Claude Code session renders its "
				+ "status line, so data ages between sessions.",
		});
		timing.add(this.spin("Refresh interval", "refresh-seconds", {
			min: 5,
			max: 600,
			subtitle: "seconds",
		}));
		timing.add(this.spin("Data is stale after", "stale-after-minutes", {
			min: 1,
			max: 1440,
			subtitle: "minutes",
		}));
		page.add(timing);

		return page;
	}

	/* Building blocks */

	private combo(title: string, key: string, choices: Choice[]): Adw.ComboRow {
		const values = choices.map((choice) => choice[0]);

		const row = new Adw.ComboRow({
			title: title,
			model: Gtk.StringList.new(choices.map((choice) => choice[1])),
			selected: Math.max(0, values.indexOf(this.settings.get_string(key))),
		});

		row.connect("notify::selected", () => {
			const value = values[row.selected];
			if (value !== undefined) {
				this.settings.set_string(key, value);
			}
		});

		return row;
	}

	private toggle(title: string, key: string, subtitle: string): Adw.SwitchRow {
		const row = new Adw.SwitchRow({ title: title, subtitle: subtitle });
		this.settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
		return row;
	}

	private spin(title: string, key: string, options: SpinOptions): Adw.SpinRow {
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

		this.settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);

		return row;
	}
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

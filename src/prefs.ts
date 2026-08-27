import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
	inspect,
	install,
	uninstall,
} from "./installer.js";
import {
	basename,
	type Profile,
	readProfiles,
	writeProfiles,
} from "./profiles.js";
import { defaultStateDir } from "./store.js";

/** Value stored in GSettings paired with the label shown for it. */
type Choice = [string, string];

interface SpinOptions {
	min: number;
	max: number;
	subtitle: string;
}

const PANEL_SOURCES: Choice[] = [
	["highest", "Closest to its limit"],
	["active", "Most recently active"],
	["profile", "A specific profile"],
	["all", "All profiles side by side"],
];

const PANEL_LIMITS: Choice[] = [
	["five-hour", "5 hour window"],
	["seven-day", "7 day window"],
	["highest", "Whichever is highest"],
];

const PANEL_FORMATS: Choice[] = [
	["icon", "Icon only"],
	["text", "Percentage only"],
	["both", "Icon and percentage"],
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
		window.add(this.advancedPage());
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
				+ "CLAUDE_CONFIG_DIR would be set to.",
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

		const note = new Adw.PreferencesGroup();
		note.add(
			new Adw.ActionRow({
				title: "The extension only reads the status line payloads",
				subtitle: `It watches ${this.stateDir()} and never reads your `
					+ "credentials or talks to the network.",
			}),
		);
		page.add(note);

		this.rebuildProfiles(window);

		return page;
	}

	private rebuildProfiles(window: Adw.PreferencesWindow): void {
		for (const row of this.rows) {
			this.group.remove(row);
		}

		this.rows = readProfiles(this.settings).map((profile, index) => {
			return this.profileRow(window, profile, index);
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

	private profileRow(
		window: Adw.PreferencesWindow,
		profile: Profile,
		index: number,
	): Adw.ExpanderRow {
		const state = inspect(profile.dir);

		const row = new Adw.ExpanderRow({
			title: profile.name,
			subtitle: `${profile.dir} · hook ${state.installed ? "installed" : "missing"}`,
		});

		const enabled = new Gtk.Switch({
			active: profile.enabled,
			valign: Gtk.Align.CENTER,
		});
		enabled.connect("notify::active", () => {
			this.patch(index, { enabled: enabled.active });
		});
		row.add_suffix(enabled);

		row.add_row(entryRow("Name", profile.name, (text) => {
			this.patch(index, { name: text });
			this.rebuildProfiles(window);
		}));

		row.add_row(entryRow("Config directory", profile.dir, (text) => {
			this.patch(index, { dir: text });
			this.rebuildProfiles(window);
		}));

		row.add_row(this.hookRow(window, profile, index));

		const remove = new Adw.ActionRow({
			title: "Remove profile",
			subtitle: "Leaves settings.json untouched. Remove the hook first.",
		});
		const removeButton = new Gtk.Button({
			icon_name: "user-trash-symbolic",
			valign: Gtk.Align.CENTER,
			css_classes: ["flat", "destructive-action"],
		});
		removeButton.connect("clicked", () => {
			const profiles = readProfiles(this.settings);
			profiles.splice(index, 1);
			writeProfiles(this.settings, profiles);
			this.rebuildProfiles(window);
		});
		remove.add_suffix(removeButton);
		row.add_row(remove);

		return row;
	}

	private hookRow(
		window: Adw.PreferencesWindow,
		profile: Profile,
		index: number,
	): Adw.ActionRow {
		const row = new Adw.ActionRow({ title: "Status line hook" });
		const state = inspect(profile.dir);

		if (!state.exists) {
			row.subtitle = "The config directory does not exist";
			return row;
		}

		if (!state.readable) {
			row.subtitle = "settings.json is not readable JSON";
			return row;
		}

		row.subtitle = state.installed
			? profile.chain === "" ? "Installed" : `Installed, chaining ${profile.chain}`
			: "Not installed, this profile stays dark until it is";

		const button = new Gtk.Button({
			label: state.installed ? "Remove" : "Install",
			valign: Gtk.Align.CENTER,
			css_classes: state.installed ? ["flat"] : ["suggested-action"],
		});

		button.connect("clicked", () => {
			if (state.installed) {
				const result = uninstall(profile.dir, profile.chain);
				if (!result.ok) {
					window.add_toast(new Adw.Toast({ title: result.error }));
					return;
				}

				this.patch(index, { chain: "" });
			} else {
				const result = install(profile.dir, this.wrapper);
				if (!result.ok) {
					window.add_toast(new Adw.Toast({ title: result.error }));
					return;
				}

				this.patch(index, { chain: result.chain });
			}

			this.rebuildProfiles(window);
		});

		row.add_suffix(button);

		return row;
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

			profiles.push({
				name: basename(dir).replace(/^\./, ""),
				dir: dir,
				enabled: true,
				chain: "",
			});

			writeProfiles(this.settings, profiles);
			this.rebuildProfiles(window);
		});
	}

	private patch(index: number, changes: Partial<Profile>): void {
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
			return [profile.dir, profile.name];
		});

		const panel = new Adw.PreferencesGroup({ title: "Panel" });
		panel.add(this.combo("Show", "panel-source", PANEL_SOURCES));
		panel.add(this.combo("Pinned profile", "panel-profile", pinnable));
		panel.add(this.combo("Limit", "panel-limit", PANEL_LIMITS));
		panel.add(this.combo("Contents", "panel-format", PANEL_FORMATS));
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

		return page;
	}

	/* Advanced */

	private advancedPage(): Adw.PreferencesPage {
		const page = new Adw.PreferencesPage({
			title: "Advanced",
			icon_name: "applications-engineering-symbolic",
		});

		const group = new Adw.PreferencesGroup({
			title: "Advanced",
			description: "Payloads only arrive while a Claude Code session renders its "
				+ "status line, so data ages between sessions.",
		});

		group.add(entryRow("State directory", this.settings.get_string("state-dir"), (text) => {
			this.settings.set_string("state-dir", text);
		}));
		group.add(this.spin("Refresh interval", "refresh-seconds", {
			min: 5,
			max: 600,
			subtitle: "seconds",
		}));
		group.add(this.spin("Data is stale after", "stale-after-minutes", {
			min: 1,
			max: 1440,
			subtitle: "minutes",
		}));
		page.add(group);

		return page;
	}

	/* Building blocks */

	private combo(title: string, key: string, choices: Choice[]): Adw.ComboRow {
		const values = choices.map((choice) => choice[0]);

		const row = new Adw.ComboRow({
			title: title,
			model: Gtk.StringList.new(
				choices.length === 0 ? ["None"] : choices.map((choice) => choice[1]),
			),
			selected: Math.max(0, values.indexOf(this.settings.get_string(key))),
			sensitive: choices.length > 0,
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

	private stateDir(): string {
		const configured = this.settings.get_string("state-dir");
		return configured === "" ? defaultStateDir() : configured;
	}
}

function entryRow(title: string, text: string, onApply: (text: string) => void): Adw.EntryRow {
	const row = new Adw.EntryRow({
		title: title,
		text: text,
		show_apply_button: true,
	});

	row.connect("apply", () => {
		onApply(row.text);
	});

	return row;
}

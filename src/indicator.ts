import Clutter from "gi://Clutter";
import type Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import type { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
	formatAge,
	formatCountdown,
	type LimitRow,
	limitRows,
	type PanelLimit,
	peakPercent,
	type Severity,
	severity,
	type StatusPayload,
	windowPercent,
} from "./format.js";
import { inspect } from "./installer.js";
import {
	type Profile,
	profileName,
	readProfiles,
} from "./profiles.js";
import {
	stateDir,
	Store,
} from "./store.js";

/** Width of a usage bar. Fills are sized against it, so it stays fixed. */
const BAR_WIDTH = 150;

/** Severity, plus the two states that are about the data rather than the usage. */
type Level = Severity | "stale" | "unknown";

interface LimitView extends LimitRow {
	level: Severity;
	countdown: string;
}

interface ProfileView {
	profile: Profile;
	name: string;
	payload: StatusPayload | null;
	/** Only meaningful without a payload, to tell "never ran" from "no hook". */
	hookInstalled: boolean;
	age: number;
	stale: boolean;
	peak: number;
	rows: LimitView[];
}

/**
 * Panel button and popup for every configured profile.
 *
 * Payloads only arrive while a Claude Code session renders its status line, so
 * every profile carries the age of its data. Showing a stale number as if it
 * were current would be worse than showing nothing.
 */
class ClaudeUsageIndicator extends PanelMenu.Button {
	private readonly extension: Extension;
	private readonly settings: Gio.Settings;
	private readonly levels = new Map<string, Level>();
	private readonly icon: St.Icon;
	private readonly label: St.Label;
	private readonly settingsHandler: number;
	private readonly openHandler: number;
	private store: Store;
	private timeout = 0;

	/**
	 * GObject subclasses have used `constructor` since GJS 1.72, and `super()`
	 * forwards to the base `_init`, which is what PanelMenu.Button defines.
	 * Older extensions still override `_init` directly; this does not need to.
	 */
	constructor(extension: Extension) {
		super(0.5, "Claude Usage");

		this.extension = extension;
		this.settings = extension.getSettings();
		this.store = new Store(stateDir());

		this.icon = new St.Icon({
			icon_name: "utilities-system-monitor-symbolic",
			style_class: "system-status-icon",
		});

		this.label = new St.Label({ y_align: Clutter.ActorAlign.CENTER });

		const box = new St.BoxLayout({
			style_class: "panel-status-menu-box",
			orientation: Clutter.Orientation.HORIZONTAL,
		});
		box.add_child(this.icon);
		box.add_child(this.label);
		this.add_child(box);

		this.settingsHandler = this.settings.connect("changed", (_settings, key: string) => {
			if (key === "refresh-seconds") {
				this.startTimer();
			}

			this.tick(true);
		});

		this.openHandler = this.popup.connect("open-state-changed", (_menu, open) => {
			if (open) {
				this.tick(true);
			}
		});

		this.tick(true);
		this.startTimer();
	}

	override destroy(): void {
		this.stopTimer();
		this.settings.disconnect(this.settingsHandler);
		this.popup.disconnect(this.openHandler);
		this.store.destroy();
		this.levels.clear();

		super.destroy();
	}

	/**
	 * `menu` is typed as either a real menu or a dummy, because a Button can be
	 * built without one. This one always has a real menu.
	 */
	private get popup(): PopupMenu.PopupMenu {
		return this.menu as PopupMenu.PopupMenu;
	}

	private startTimer(): void {
		this.stopTimer();

		this.timeout = GLib.timeout_add_seconds(
			GLib.PRIORITY_LOW,
			this.settings.get_int("refresh-seconds"),
			() => {
				this.tick(false);
				return GLib.SOURCE_CONTINUE;
			},
		);
	}

	private stopTimer(): void {
		if (this.timeout !== 0) {
			GLib.Source.remove(this.timeout);
			this.timeout = 0;
		}
	}

	/**
	 * One pass: re-read the state directory, then repaint what it says. The
	 * menu is only rebuilt when its contents can have changed or when it is on
	 * screen, so an idle desktop does no work beyond a handful of stats.
	 */
	private tick(force: boolean): void {
		const changed = this.store.refresh();
		const views = this.collect();

		this.renderPanel(views);
		this.notifyThresholds(views);

		if (force || changed || this.popup.isOpen) {
			this.rebuildMenu(views);
		}
	}

	/** Merge configured profiles with whatever the state directory holds. */
	private collect(): ProfileView[] {
		const now = GLib.DateTime.new_now_local().to_unix();
		const staleAfter = this.settings.get_int("stale-after-minutes") * 60;

		return readProfiles(this.settings)
			.filter((profile) => {
				return profile.enabled;
			})
			.map((profile) => {
				const entry = this.store.get(profile.dir);
				const payload = entry ? entry.payload : null;
				const age = entry ? Math.max(0, now - entry.updatedAt) : Number.POSITIVE_INFINITY;

				const rows: LimitView[] = limitRows(payload).map((row) => {
					return {
						...row,
						level: this.severityOf(row.percent),
						countdown: row.resetsAt === null
							? ""
							: formatCountdown(row.resetsAt - now),
					};
				});

				return {
					profile: profile,
					name: profileName(profile.dir),
					payload: payload,
					// inspect() reads a file, so only ask when there is a
					// reason to: a profile that has never reported.
					hookInstalled: payload !== null || inspect(profile.dir).installedIn !== null,
					age: age,
					stale: age > staleAfter,
					peak: peakPercent(rows),
					rows: rows,
				};
			});
	}

	private severityOf(percent: number): Severity {
		return severity(
			Number.isFinite(percent) ? percent : 0,
			this.settings.get_int("warning-threshold"),
			this.settings.get_int("critical-threshold"),
		);
	}

	private renderPanel(views: ProfileView[]): void {
		const usable = views.filter((view) => {
			return view.payload !== null;
		});
		const hideStale = this.settings.get_boolean("hide-when-stale");
		const allStale = usable.every((view) => {
			return view.stale;
		});

		if (usable.length === 0 || (hideStale && allStale)) {
			this.visible = !hideStale;
			this.label.text = "--";
			this.label.style_class = "claude-usage-panel-label claude-usage-unknown";
			return;
		}

		this.visible = true;

		const window = this.settings.get_string("panel-limit") as PanelLimit;
		const shown = this.panelViews(usable);
		const percents = shown.map((view) => {
			return windowPercent(view.rows, window);
		});

		this.label.text = percents.map((percent) => {
			return Number.isFinite(percent) ? `${Math.round(percent)}%` : "--";
		}).join(" · ");

		const level: Level = shown.some((view) => view.stale)
			? "stale"
			: percents.map((percent) => this.severityOf(percent)).reduce(worse, "normal" as Level);

		this.label.style_class = `claude-usage-panel-label claude-usage-${level}`;
	}

	/**
	 * Which profiles the panel button stands for. The setting holds either a
	 * strategy or the config directory of one pinned profile.
	 */
	private panelViews(usable: ProfileView[]): ProfileView[] {
		const source = this.settings.get_string("panel-source");

		if (source === "all") {
			return usable;
		}

		if (source === "active") {
			return [usable.reduce((best, view) => {
				return view.age < best.age ? view : best;
			})];
		}

		if (source !== "highest") {
			const pinned = usable.find((view) => {
				return view.profile.dir === source;
			});

			if (pinned !== undefined) {
				return [pinned];
			}
		}

		return [usable.reduce((best, view) => {
			return peakOf(view) > peakOf(best) ? view : best;
		})];
	}

	private rebuildMenu(views: ProfileView[]): void {
		this.popup.removeAll();

		if (views.length === 0) {
			this.popup.addMenuItem(
				new PopupMenu.PopupMenuItem("No profiles configured", { reactive: false }),
			);
		}

		views.forEach((view, index) => {
			if (index > 0) {
				this.popup.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
			}

			for (const item of sectionItems(view)) {
				this.popup.addMenuItem(item);
			}
		});

		this.popup.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		const preferences = new PopupMenu.PopupMenuItem("Settings…");
		preferences.connect("activate", () => {
			this.extension.openPreferences();
		});
		this.popup.addMenuItem(preferences);
	}

	private notifyThresholds(views: ProfileView[]): void {
		if (!this.settings.get_boolean("notify-threshold")) {
			return;
		}

		for (const view of views) {
			const level: Level = view.payload === null ? "normal" : this.severityOf(view.peak);
			const previous = this.levels.get(view.profile.dir) ?? "normal";

			if (!view.stale && rank(level) > rank(previous)) {
				Main.notify(
					`Claude usage: ${view.name}`,
					`${Math.round(view.peak)}% of a rate limit window used.`,
				);
			}

			this.levels.set(view.profile.dir, level);
		}
	}
}

// registerClass wires up the GType and hands back the very class it was given,
// so exporting the class directly keeps this subclass's constructor signature
// instead of the widened one the GObject overloads infer.
GObject.registerClass(ClaudeUsageIndicator);

export const Indicator = ClaudeUsageIndicator;

/** Header, one row per limit window and a footer, for a single profile. */
function sectionItems(view: ProfileView): PopupMenu.PopupBaseMenuItem[] {
	const items: PopupMenu.PopupBaseMenuItem[] = [];

	const model = view.payload?.model?.display_name;
	const header = row("claude-usage-header");
	header.add_child(
		new St.Label({
			text: model ? `${view.name} · ${model}` : view.name,
			style_class: "claude-usage-name",
			x_expand: true,
		}),
	);
	header.add_child(
		new St.Label({
			text: view.payload === null ? "no data" : formatAge(view.age),
			style_class: view.stale ? "claude-usage-age claude-usage-stale" : "claude-usage-age",
		}),
	);
	items.push(header);

	for (const limit of view.rows) {
		const item = row("claude-usage-row");
		item.add_child(
			new St.Label({
				text: limit.title,
				style_class: "claude-usage-row-title",
			}),
		);
		item.add_child(usageBar(limit.percent, limit.level));
		item.add_child(
			new St.Label({
				text: `${Math.round(limit.percent)}%`,
				style_class: `claude-usage-row-percent claude-usage-${limit.level}`,
			}),
		);
		item.add_child(
			new St.Label({
				text: limit.countdown,
				style_class: "claude-usage-row-countdown",
			}),
		);
		items.push(item);
	}

	if (view.payload === null) {
		items.push(
			new PopupMenu.PopupMenuItem(
				view.hookInstalled
					? "Waiting for this profile's first session"
					: "Status line hook not installed",
				{ reactive: false },
			),
		);
		return items;
	}

	// Claude Code fetches the limits asynchronously, so the first payloads of a
	// session carry everything but rate_limits.
	if (view.rows.length === 0) {
		items.push(
			new PopupMenu.PopupMenuItem("No rate limits reported yet", { reactive: false }),
		);
	}

	const footer = row("claude-usage-footer");
	footer.add_child(
		new St.Label({
			text: footerText(view.payload),
			style_class: "claude-usage-footer-label",
		}),
	);
	items.push(footer);

	return items;
}

function row(styleClass: string): PopupMenu.PopupBaseMenuItem {
	return new PopupMenu.PopupBaseMenuItem({
		reactive: false,
		can_focus: false,
		style_class: styleClass,
	});
}

/**
 * A fixed width track with an explicitly sized fill. St resolves widths from
 * CSS, so the fill is aligned to the start of a bin layout and given its width
 * in pixels; colours stay in the stylesheet.
 */
function usageBar(percent: number, level: Severity): St.Widget {
	const track = new St.Widget({
		style_class: "claude-usage-bar",
		layout_manager: new Clutter.BinLayout(),
		y_align: Clutter.ActorAlign.CENTER,
	});

	const filled = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

	track.add_child(
		new St.Widget({
			style_class: `claude-usage-bar-fill claude-usage-${level}`,
			style: `width: ${Math.round(BAR_WIDTH * filled / 100)}px;`,
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.FILL,
		}),
	);

	return track;
}

function footerText(payload: StatusPayload): string {
	const parts: string[] = [];

	const context = payload.context_window?.used_percentage;
	if (Number.isFinite(context)) {
		parts.push(`context ${Math.round(context as number)}%`);
	}

	const cost = payload.cost?.total_cost_usd;
	if (Number.isFinite(cost) && (cost as number) > 0) {
		parts.push(`$${(cost as number).toFixed(2)}`);
	}

	const dir = payload.workspace?.current_dir;
	if (typeof dir === "string" && dir !== "") {
		parts.push(dir.split("/").filter(Boolean).at(-1) ?? dir);
	}

	return parts.join(" · ");
}

function peakOf(view: ProfileView): number {
	return Number.isFinite(view.peak) ? view.peak : -1;
}

function worse(left: Level, right: Level): Level {
	return rank(right) > rank(left) ? right : left;
}

function rank(level: Level): number {
	return ["normal", "unknown", "stale", "warning", "critical"].indexOf(level);
}

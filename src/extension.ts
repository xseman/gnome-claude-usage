import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { discoverConfigDirs } from "./configDir.js";
import { Indicator } from "./indicator.js";
import {
	readProfiles,
	writeProfiles,
} from "./profiles.js";

export default class ClaudeUsageExtension extends Extension {
	private indicator: InstanceType<typeof Indicator> | null = null;

	override enable(): void {
		this.indicator = new Indicator(this);
		Main.panel.addToStatusArea(this.uuid, this.indicator);
		void this.seedProfiles();
	}

	/**
	 * First enable: offer every config directory a Claude Code login left
	 * behind. Runs once, so a list the user emptied stays empty.
	 */
	private async seedProfiles(): Promise<void> {
		const settings = this.getSettings();
		if (settings.get_boolean("profiles-seeded") || readProfiles(settings).length > 0) {
			return;
		}

		const dirs = await discoverConfigDirs();
		if (this.indicator === null) {
			return;
		}

		writeProfiles(settings, dirs.map((dir) => ({ dir: dir, enabled: true, chain: "" })));
		settings.set_boolean("profiles-seeded", true);
	}

	override disable(): void {
		this.indicator?.destroy();
		this.indicator = null;
	}
}

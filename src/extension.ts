import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { Indicator } from "./indicator.js";

export default class ClaudeUsageExtension extends Extension {
	private indicator: InstanceType<typeof Indicator> | null = null;

	override enable(): void {
		this.indicator = new Indicator(this);
		Main.panel.addToStatusArea(this.uuid, this.indicator);
	}

	override disable(): void {
		this.indicator?.destroy();
		this.indicator = null;
	}
}

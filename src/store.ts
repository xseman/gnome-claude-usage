import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
	slugify,
	type StatusPayload,
} from "./format.js";

/** A payload on disk, with the time the wrapper wrote it. */
export interface StoreEntry {
	payload: StatusPayload;
	updatedAt: number;
}

interface CachedEntry {
	/** Modification time and size, to skip files that have not moved. */
	stamp: string;
	payload: StatusPayload | null;
	updatedAt: number;
}

/**
 * Reads the status payloads written by bin/claude-usage-statusline.
 *
 * The store is the only part of the extension that touches the disk. Payloads
 * are a few hundred bytes each, so a refresh stats a handful of files and only
 * parses the ones whose modification time or size moved.
 *
 * Refreshing is pull based rather than driven by a Gio.FileMonitor, which needs
 * an inotify instance. Those are a per-user kernel resource capped by
 * fs.inotify.max_user_instances, 128 by default, and a desktop full of editors
 * and language servers runs out of them routinely. Once it does,
 * `monitor_directory` fails with "Unable to find default local file monitor
 * type" for every GIO client and `monitor_file` degrades to polling anyway.
 * Stating a handful of small files on the timer the countdowns already need
 * cannot fail that way, and is one code path fewer.
 *
 * Entries are keyed by the slug of their config directory rather than by the
 * directory itself: slugging cannot be reversed, and only the forward direction
 * is ever needed.
 */
export class Store {
	private readonly entries = new Map<string, CachedEntry>();
	private readonly decoder = new TextDecoder();
	private readonly dir: Gio.File;

	constructor(dir: string) {
		this.dir = Gio.File.new_for_path(dir);
		ensureDirectory(this.dir);
		this.refresh();
	}

	/** Entry for a config directory, or null when that profile never reported. */
	get(configDir: string): StoreEntry | null {
		const entry = this.entries.get(slugify(configDir));

		return entry?.payload == null
			? null
			: { payload: entry.payload, updatedAt: entry.updatedAt };
	}

	/**
	 * Re-read what changed on disk. Returns true when any payload appeared,
	 * vanished or moved.
	 */
	refresh(): boolean {
		const seen = new Set<string>();
		let changed = false;

		for (const info of this.list()) {
			const name = info.get_name();
			if (!name.endsWith(".json")) {
				continue;
			}

			const slug = name.replace(/\.json$/, "");
			const modified = info.get_modification_date_time();
			const updatedAt = modified ? modified.to_unix() : 0;
			const stamp = `${updatedAt}:${info.get_size()}`;

			seen.add(slug);

			if (this.entries.get(slug)?.stamp === stamp) {
				continue;
			}

			changed = true;

			// A file that fails to parse is still recorded, with a null
			// payload. Forgetting it instead would re-read and re-report it on
			// every refresh for as long as it stays corrupt.
			this.entries.set(slug, {
				stamp: stamp,
				payload: this.read(this.dir.get_child(name)),
				updatedAt: updatedAt,
			});
		}

		for (const slug of Array.from(this.entries.keys())) {
			if (!seen.has(slug)) {
				this.entries.delete(slug);
				changed = true;
			}
		}

		return changed;
	}

	destroy(): void {
		this.entries.clear();
	}

	private list(): Gio.FileInfo[] {
		const infos: Gio.FileInfo[] = [];

		let enumerator: Gio.FileEnumerator;
		try {
			enumerator = this.dir.enumerate_children(
				"standard::name,standard::size,time::modified",
				Gio.FileQueryInfoFlags.NONE,
				null,
			);
		} catch {
			// The directory can be removed underneath us at any time.
			return infos;
		}

		let info = enumerator.next_file(null);
		while (info !== null) {
			infos.push(info);
			info = enumerator.next_file(null);
		}

		enumerator.close(null);

		return infos;
	}

	private read(file: Gio.File): StatusPayload | null {
		try {
			const [ok, contents] = file.load_contents(null);
			return ok ? JSON.parse(this.decoder.decode(contents)) as StatusPayload : null;
		} catch {
			// A half written file resolves itself on the next refresh, and a
			// corrupt one must not take the panel down with it.
			return null;
		}
	}
}

/**
 * Where the wrapper writes. Not configurable: the wrapper derives the same path
 * from XDG_STATE_HOME, and a setting only on this side would desync the two.
 */
export function stateDir(): string {
	return GLib.build_filenamev([GLib.get_user_state_dir(), "claude-usage"]);
}

function ensureDirectory(dir: Gio.File): void {
	try {
		dir.make_directory_with_parents(null);
	} catch (error) {
		if (!(error instanceof GLib.Error) || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
			throw error;
		}
	}
}

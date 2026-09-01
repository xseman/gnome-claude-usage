import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
	slugify,
	type StatusPayload,
} from "./format.js";

// Promise-returning variants of the async Gio calls used below.
Gio._promisify(Gio.File.prototype, "enumerate_children_async");
Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.FileEnumerator.prototype, "next_files_async");

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
 * Reads the status payloads written by bin/claude-usage-statusline.js.
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
	 * vanished or moved. All IO is asynchronous: the shell process must never
	 * block on a file, however small.
	 */
	async refresh(): Promise<boolean> {
		const seen = new Set<string>();
		let changed = false;

		for (const info of await this.list()) {
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
				payload: await this.read(this.dir.get_child(name)),
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

	private async list(): Promise<Gio.FileInfo[]> {
		let enumerator: Gio.FileEnumerator;
		try {
			enumerator = await this.dir.enumerate_children_async(
				"standard::name,standard::size,time::modified",
				Gio.FileQueryInfoFlags.NONE,
				GLib.PRIORITY_DEFAULT,
				null,
			);
		} catch {
			// The directory can be removed underneath us at any time.
			return [];
		}

		const infos: Gio.FileInfo[] = [];
		for (;;) {
			const batch = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
			if (batch.length === 0) {
				break;
			}

			infos.push(...batch);
		}

		enumerator.close(null);

		return infos;
	}

	private async read(file: Gio.File): Promise<StatusPayload | null> {
		try {
			const [contents] = await file.load_contents_async(null);
			return JSON.parse(this.decoder.decode(contents)) as StatusPayload;
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

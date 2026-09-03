import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";

import { readCredentials } from "./configDir.js";
import {
	slugify,
	type StatusPayload,
} from "./format.js";

/**
 * Optional live source: the endpoint Claude Code's /usage command calls,
 * authenticated with the token Claude Code already stored. Used only when the
 * user turns it on, and only to fill the gap the status line hook leaves
 * between sessions.
 *
 * The token is used as found and never refreshed here. Refreshing rotates the
 * refresh token, and a second client doing that races the running session, so
 * an expired token simply reports "expired" until Claude Code renews it.
 */

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Why a fetch produced no payload. */
export type FetchFailure = "no-token" | "expired" | "rate-limited" | "network" | `http-${number}`;

Gio._promisify(Gio.File.prototype, "replace_contents_async", "replace_contents_finish");
Gio._promisify(Soup.Session.prototype, "send_and_read_async");

/**
 * Shape the endpoint's JSON like a status line payload, so the store, the
 * rows and the panel need no second code path. The endpoint reports the same
 * windows under the same keys with `utilization` and an ISO `resets_at`, both
 * of which the row parser already accepts.
 */
export function payloadFromUsage(json: Record<string, unknown>): StatusPayload {
	const limits: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(json)) {
		if (key !== "limits" && value !== null && typeof value === "object") {
			limits[key] = value;
		}
	}

	// Model scoped weekly windows (Fable, Opus, ...) are only reported in the
	// limits array, under the model's display name.
	const entries = Array.isArray(json["limits"]) ? json["limits"] as unknown[] : [];
	for (const entry of entries) {
		const limit = entry as {
			kind?: unknown;
			percent?: unknown;
			resets_at?: unknown;
			scope?: { model?: { display_name?: unknown; }; } | null;
		};
		const name = limit.scope?.model?.display_name;
		if (limit.kind !== "weekly_scoped" || typeof name !== "string" || typeof limit.percent !== "number") {
			continue;
		}

		limits[`weekly_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`] = {
			utilization: limit.percent,
			resets_at: limit.resets_at,
		};
	}

	return { rate_limits: limits };
}

export class UsageClient {
	private readonly session = new Soup.Session({ timeout: 15 });

	/**
	 * Fetch usage for a profile and write it where the status line wrapper
	 * would, so the store picks it up on its next refresh. Returns null on
	 * success, otherwise the reason nothing was written.
	 */
	async refresh(configDir: string, stateDir: string): Promise<FetchFailure | null> {
		const credentials = await readCredentials(configDir);
		const token = credentials?.accessToken;
		if (!token) {
			return "no-token";
		}

		if (credentials.expiresAt !== null && credentials.expiresAt < Date.now()) {
			return "expired";
		}

		const message = Soup.Message.new("GET", USAGE_URL);
		const headers = message.get_request_headers();
		headers.append("Authorization", `Bearer ${token}`);
		headers.append("anthropic-beta", "oauth-2025-04-20");
		headers.append("Content-Type", "application/json");

		let bytes: GLib.Bytes;
		try {
			bytes = await this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
		} catch {
			return "network";
		}

		// status_code is the raw guint; get_status() throws on codes outside
		// the SoupStatus enum, 429 among them.
		const status = message.status_code;
		if (status === 401 || status === 403) {
			return "expired";
		}
		if (status === 429) {
			return "rate-limited";
		}
		if (status < 200 || status >= 300) {
			return `http-${status}`;
		}

		let json: unknown;
		try {
			json = JSON.parse(new TextDecoder().decode(bytes.toArray()));
		} catch {
			return "network";
		}
		if (json === null || typeof json !== "object") {
			return "network";
		}

		const file = Gio.File.new_for_path(
			GLib.build_filenamev([stateDir, `${slugify(configDir)}.json`]),
		);
		const body = JSON.stringify(payloadFromUsage(json as Record<string, unknown>));

		try {
			await file.replace_contents_async(
				new TextEncoder().encode(body),
				null,
				false,
				Gio.FileCreateFlags.NONE,
				null,
			);
		} catch {
			return "network";
		}

		return null;
	}
}

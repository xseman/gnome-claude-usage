/**
 * Payload types and the pure helpers that interpret them.
 *
 * Nothing here imports GNOME Shell, so the module can be exercised directly
 * with gjs. See test/format.test.js.
 */

/** Everything the status line payload carries that this extension reads. */
export interface StatusPayload {
	model?: { display_name?: string; };
	workspace?: { current_dir?: string; };
	cost?: { total_cost_usd?: number; };
	context_window?: { used_percentage?: number; };
	/** Values are RateLimit objects, but Claude Code also puts flags in here. */
	rate_limits?: Record<string, unknown>;
}

export interface RateLimit {
	used_percentage?: number;
	utilization?: number;
	resets_at?: number | string;
}

/** One rate limit window, ready for rendering. */
export interface LimitRow extends Measured {
	title: string;
	resetsAt: number | null;
}

/** The part of a limit row peakPercent and windowPercent need. */
export interface Measured {
	key: string;
	percent: number;
}

export type Severity = "normal" | "warning" | "critical";

/** Rate limit window the panel button can show. */
export type PanelLimit = "five-hour" | "seven-day" | "highest";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Epoch values above this many seconds are milliseconds, not seconds. */
const MILLISECOND_EPOCH_CUTOFF = 100_000_000_000;

/** Order the known rate limit windows are rendered in. */
const LIMIT_ORDER = [
	"five_hour",
	"seven_day",
];

/**
 * Turn a config directory into the file name the status line wrapper writes.
 * Mirrors the sed expression in bin/claude-usage-statusline.
 *
 * Claude Code slugs project paths by replacing every slash with a dash, which
 * is not injective: `~/.claude-work` and `~/.claude/work` would collide and
 * silently share one state file. Doubling existing dashes first keeps the
 * result readable and unambiguous.
 */
export function slugify(configDir: string): string {
	return configDir.replace(/-/g, "--").replace(/\//g, "-");
}

/**
 * Normalise a `resets_at` field to epoch seconds. Claude Code reports epoch
 * seconds today, but an ISO string or milliseconds should not break rendering.
 */
export function parseResetsAt(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > MILLISECOND_EPOCH_CUTOFF
			? Math.floor(value / 1000)
			: Math.floor(value);
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) {
			return Math.floor(parsed / 1000);
		}
	}

	return null;
}

/**
 * Render seconds remaining the way the status line does: the two most
 * significant units, never more.
 */
export function formatCountdown(seconds: number): string {
	const left = Math.max(0, Math.floor(seconds));

	if (left >= DAY) {
		const days = Math.floor(left / DAY);
		const hours = Math.floor((left % DAY) / HOUR);
		return `${days} d ${String(hours).padStart(2, "0")} h`;
	}

	if (left >= HOUR) {
		const hours = Math.floor(left / HOUR);
		const minutes = Math.floor((left % HOUR) / MINUTE);
		return `${hours} h ${String(minutes).padStart(2, "0")} m`;
	}

	return `${Math.floor(left / MINUTE)} m`;
}

/**
 * Render how old a payload is. Freshness matters more than precision here: a
 * panel that silently shows week old numbers is worse than no panel.
 */
export function formatAge(seconds: number): string {
	const age = Math.max(0, Math.floor(seconds));

	if (age < MINUTE) {
		return "now";
	}

	if (age < HOUR) {
		return `${Math.floor(age / MINUTE)} min ago`;
	}

	if (age < DAY) {
		return `${Math.floor(age / HOUR)} h ago`;
	}

	return `${Math.floor(age / DAY)} d ago`;
}

/** Classify a percentage against the configured thresholds. */
export function severity(percent: number, warning: number, critical: number): Severity {
	if (percent >= critical) {
		return "critical";
	}

	if (percent >= warning) {
		return "warning";
	}

	return "normal";
}

/**
 * Turn `seven_day_opus` into `7 d Opus`, `five_hour` into `5 h`. Model scoped
 * weekly limits are plan specific, so the label is derived rather than listed.
 */
export function limitTitle(key: string): string {
	if (key === "five_hour") {
		return "5 h";
	}

	if (key === "seven_day") {
		return "7 d";
	}

	if (key.startsWith("seven_day_")) {
		const model = key.slice("seven_day_".length).replace(/_/g, " ");
		return `7 d ${model.charAt(0).toUpperCase()}${model.slice(1)}`;
	}

	return key.replace(/_/g, " ");
}

/**
 * Flatten the `rate_limits` object of a status payload into rows ready for
 * rendering. Unknown keys are kept so a new limit window shows up without a
 * code change; known ones keep a stable order.
 */
export function limitRows(payload: StatusPayload | null): LimitRow[] {
	const limits = payload?.rate_limits;
	if (!limits || typeof limits !== "object") {
		return [];
	}

	const rows: LimitRow[] = [];

	for (const [key, value] of Object.entries(limits)) {
		const percent = percentOf(value);
		if (!Number.isFinite(percent)) {
			continue;
		}

		rows.push({
			key: key,
			title: limitTitle(key),
			percent: percent,
			resetsAt: parseResetsAt((value as RateLimit).resets_at),
		});
	}

	rows.sort((left, right) => {
		return rankOf(left.key) - rankOf(right.key) || left.key.localeCompare(right.key);
	});

	return rows;
}

/**
 * Highest percentage across a payload's limit windows.
 *
 * This and windowPercent take already parsed rows rather than a payload, so a
 * caller that needs both, and the rows themselves, parses only once.
 */
export function peakPercent(rows: readonly Measured[]): number {
	if (rows.length === 0) {
		return Number.NaN;
	}

	return rows.reduce((peak, row) => {
		return Math.max(peak, row.percent);
	}, 0);
}

/** Percentage for a single named window, used by the panel button. */
export function windowPercent(rows: readonly Measured[], window: PanelLimit): number {
	if (window === "highest") {
		return peakPercent(rows);
	}

	const wanted = window === "five-hour" ? "five_hour" : "seven_day";
	const row = rows.find((candidate) => {
		return candidate.key === wanted;
	});

	return row ? row.percent : Number.NaN;
}

/**
 * Read a percentage off a limit. `used_percentage` is what the status line
 * documents, `utilization` is carried alongside it.
 */
function percentOf(limit: unknown): number {
	if (limit === null || typeof limit !== "object") {
		return Number.NaN;
	}

	const { used_percentage: used, utilization } = limit as RateLimit;

	if (Number.isFinite(used)) {
		return used as number;
	}

	if (Number.isFinite(utilization)) {
		return utilization as number;
	}

	return Number.NaN;
}

function rankOf(key: string): number {
	const index = LIMIT_ORDER.indexOf(key);
	return index === -1 ? LIMIT_ORDER.length : index;
}

#!/usr/bin/env -S gjs -m
/**
 * Unit tests for src/lib/format.js.
 *
 * Run with `gjs -m test/format.test.js`. The module under test is deliberately
 * free of GNOME Shell imports so it runs outside the shell process.
 */

import {
	formatAge,
	formatCountdown,
	limitRows,
	limitTitle,
	parseResetsAt,
	peakPercent,
	severity,
	slugify,
	tierLabel,
	windowPercent,
} from "../lib/format.js";
import {
	check,
	report,
} from "./harness.js";

check("slugify mirrors the shell", slugify("/home/me/.claude"), "-home-me-.claude");
check("slugify escapes existing dashes", slugify("/home/me/.claude-work"), "-home-me-.claude--work");
check("slugify keeps nesting distinct", slugify("/home/me/.claude/work"), "-home-me-.claude-work");

check("parseResetsAt keeps epoch seconds", parseResetsAt(1_787_842_120), 1_787_842_120);
check("parseResetsAt narrows milliseconds", parseResetsAt(1_787_842_120_290), 1_787_842_120);
check("parseResetsAt reads ISO strings", parseResetsAt("2026-08-27T10:00:00Z"), 1_787_824_800);
check("parseResetsAt rejects junk", parseResetsAt("later"), null);

check("formatCountdown days", formatCountdown(357_000), "4 d 03 h");
check("formatCountdown hours", formatCountdown(7_860), "2 h 11 m");
check("formatCountdown minutes", formatCountdown(1_500), "25 m");
check("formatCountdown clamps the past", formatCountdown(-10), "0 m");

check("formatAge fresh", formatAge(12), "now");
check("formatAge minutes", formatAge(240), "4 min ago");
check("formatAge hours", formatAge(10_800), "3 h ago");
check("formatAge days", formatAge(180_000), "2 d ago");

check("severity normal", severity(43, 70, 90), "normal");
check("severity warning", severity(70, 70, 90), "warning");
check("severity critical", severity(91, 70, 90), "critical");

check("tierLabel max with multiplier", tierLabel("max", "default_claude_max_5x"), "Max 5x");
check("tierLabel pro", tierLabel("pro", "default_claude_pro"), "Pro");
check("tierLabel strips a claude prefix", tierLabel("claude_team", null), "Team");
check("tierLabel without a login", tierLabel(null, null), "");

check("limitTitle five hour", limitTitle("five_hour"), "5 h");
check("limitTitle seven day", limitTitle("seven_day"), "7 d");
check("limitTitle model scoped", limitTitle("seven_day_opus"), "7 d Opus");

const payload = {
	rate_limits: {
		seven_day_opus: { used_percentage: 22, resets_at: 1_787_842_120 },
		five_hour: { used_percentage: 43.2, resets_at: 1_787_800_000 },
		seven_day: { utilization: 68, resets_at: 1_787_842_120 },
		rate_limits_available: true,
	},
};

check("limitRows orders known windows first", limitRows(payload).map((row) => row.key), [
	"five_hour",
	"seven_day",
	"seven_day_opus",
]);
check("limitRows drops non limit keys", limitRows(payload).length, 3);
check("limitRows falls back to utilization", limitRows(payload)[1].percent, 68);
check("peakPercent", peakPercent(limitRows(payload)), 68);
check("windowPercent five hour", windowPercent(limitRows(payload), "five-hour"), 43.2);
check("windowPercent highest", windowPercent(limitRows(payload), "highest"), 68);
check("limitRows tolerates a payload without limits", limitRows({}), []);
check("peakPercent without limits is NaN", Number.isNaN(peakPercent(limitRows({}))), true);

report();

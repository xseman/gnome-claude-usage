#!/usr/bin/env -S gjs -m
/**
 * Tests for the pure part of src/usageClient.ts: turning the endpoint's JSON
 * into a status line shaped payload. The fixture is a captured response.
 * Nothing here touches the network.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { limitRows } from "../lib/format.js";
import { payloadFromUsage } from "../lib/usageClient.js";
import {
	check,
	report,
} from "./harness.js";

const here = GLib.path_get_dirname(import.meta.url.replace("file://", ""));
const [, bytes] = Gio.File.new_for_path(`${here}/fixtures/usage.json`).load_contents(null);
const json = JSON.parse(new TextDecoder().decode(bytes));

const payload = payloadFromUsage(json);
check("keeps the window objects", Object.keys(payload.rate_limits).sort(), ["five_hour", "seven_day"]);
check("drops the limits array", "limits" in payload.rate_limits, false);
check("drops null windows", "seven_day_opus" in payload.rate_limits, false);

const rows = limitRows(payload);
check("rows come out in the usual order", rows.map((row) => row.key), ["five_hour", "seven_day"]);
check("utilization becomes the percentage", rows[0].percent, 15);
check("an ISO resets_at becomes epoch seconds", rows[0].resetsAt, 1_783_526_400);
check("titles match the status line ones", rows.map((row) => row.title), ["5 h", "7 d"]);

report();

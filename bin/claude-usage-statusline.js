// Claude Code statusLine wrapper for the "Claude Limits" GNOME Shell extension.
//
// Claude Code pipes a JSON status payload to the configured statusLine command
// on every render. That payload is the only local source of subscription rate
// limit percentages, so this script stores it verbatim for the extension to
// read, then hands the same stdin to whatever status line was configured
// before.
//
// Nothing is parsed here on purpose: the extension already speaks JSON, and
// the write stays atomic.
//
// Environment:
//   CLAUDE_USAGE_DIR    Config dir this profile stands for. install.sh and the
//                       preferences dialog bake it into the command string, so
//                       the profile is identified even when the variable is
//                       not exported into the session.
//   CLAUDE_USAGE_CHAIN  Previous statusLine command; receives the same stdin.
//   CLAUDE_CONFIG_DIR   Fallback when CLAUDE_USAGE_DIR is unset.
//   XDG_STATE_HOME      State root, defaults to ~/.local/state.

import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";
import System from "system";

/**
 * Profile identity is the config dir path slugified into a file name:
 *   /home/me/.claude       -> -home-me-.claude
 *   /home/me/.claude-work  -> -home-me-.claude--work
 *   /home/me/.claude/work  -> -home-me-.claude-work
 * Existing dashes are doubled before slashes become dashes, otherwise the last
 * two paths would collide and share one state file. Kept in step with
 * slugify() in src/format.ts.
 */
function slugify(configDir) {
	return configDir.replace(/-/g, "--").replace(/\//g, "-");
}

function readStdin() {
	const buffer = Gio.MemoryOutputStream.new_resizable();

	buffer.splice(
		GioUnix.InputStream.new(0, false),
		Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
		null,
	);

	return buffer.steal_as_bytes();
}

const configDir = GLib.getenv("CLAUDE_USAGE_DIR")
	?? GLib.getenv("CLAUDE_CONFIG_DIR")
	?? GLib.build_filenamev([GLib.get_home_dir(), ".claude"]);

const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), "claude-usage"]);
const payload = readStdin();

// An empty payload would only overwrite good data with nothing.
if (payload.get_size() > 0) {
	// The payload carries the working directory and spend of the session.
	GLib.mkdir_with_parents(stateDir, 0o700);

	const file = Gio.File.new_for_path(
		GLib.build_filenamev([stateDir, `${slugify(configDir)}.json`]),
	);

	// replace_contents writes to a temporary file and renames it into place, so
	// a reader never sees a half written payload.
	file.replace_contents(payload.toArray(), null, false, Gio.FileCreateFlags.NONE, null);
}

// Hand over to the status line that was configured before the wrapper. Its
// stdout and stderr are inherited, and its exit status becomes ours, so a
// broken chain surfaces in Claude Code instead of being hidden.
const chain = GLib.getenv("CLAUDE_USAGE_CHAIN");
if (chain) {
	const proc = Gio.Subprocess.new(["sh", "-c", chain], Gio.SubprocessFlags.STDIN_PIPE);
	const stdin = proc.get_stdin_pipe();

	stdin.write_all(payload.toArray(), null);
	stdin.close(null);
	proc.wait(null);

	System.exit(proc.get_exit_status());
}

/** Assertion helper shared by the suites. */

let failures = 0;

export function check(label, actual, expected) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures += 1;
		printerr(`FAIL ${label}`);
		printerr(`  expected ${JSON.stringify(expected)}`);
		printerr(`  actual   ${JSON.stringify(actual)}`);
		return;
	}

	print(`ok   ${label}`);
}

/** Exits non-zero when anything failed, so ./test/run.sh stops on it. */
export function report() {
	if (failures > 0) {
		printerr(`\n${failures} failing check(s)`);
		imports.system.exit(1);
	}

	print("\nall checks passed");
}

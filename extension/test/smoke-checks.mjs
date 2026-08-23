/**
 * Shared result collector for smoke-domain suites.
 * Domain modules receive only `check`; process ownership stays with the runner.
 */
export function createSmokeChecks() {
  let failures = 0;

  const check = (condition, name) => {
    if (condition) console.log(`  ok: ${name}`);
    else {
      console.error(`FAIL: ${name}`);
      failures++;
    }
  };

  const finish = () => {
    if (failures > 0) {
      console.error(`\n${failures} test(s) FAILED`);
      process.exit(1);
    }
    console.log("\nAll smoke tests passed");
    process.exit(0);
  };

  return { check, finish };
}

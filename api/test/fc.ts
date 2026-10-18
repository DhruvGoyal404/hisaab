// fast-check configuration shared by every property test (loaded via vitest setupFiles).
//
// On failure the seed, the replay path and the shrunk counterexample go to stderr, so they land
// in local output and CI logs even when a reporter truncates the thrown error. To replay:
//   FC_SEED=<seed> FC_PATH=<path> npx vitest run test/<file>
// FC_NUM_RUNS overrides every property's run count (e.g. FC_NUM_RUNS=50000 for a soak run).
import fc from 'fast-check';

const env = process.env;

fc.configureGlobal({
  ...(env.FC_SEED !== undefined && { seed: Number(env.FC_SEED) }),
  ...(env.FC_PATH !== undefined && { path: env.FC_PATH }),
  ...(env.FC_NUM_RUNS !== undefined && { numRuns: Number(env.FC_NUM_RUNS) }),
  reporter: (out) => {
    if (!out.failed) return;
    process.stderr.write(
      `\n[fast-check] property failed after ${out.numRuns} run(s) and ${out.numShrinks} shrink(s)\n` +
        `[fast-check] seed=${out.seed} path=${out.counterexamplePath ?? ''}\n` +
        `[fast-check] counterexample: ${fc.stringify(out.counterexample)}\n` +
        `[fast-check] replay: FC_SEED=${out.seed} FC_PATH=${out.counterexamplePath ?? ''}\n`,
    );
    throw new Error(fc.defaultReportMessage(out));
  },
});

/** Run count for a property: `n` unless FC_NUM_RUNS overrides it. */
export const runs = (n: number): { numRuns: number } => ({ numRuns: env.FC_NUM_RUNS ? Number(env.FC_NUM_RUNS) : n });

/**
 * Timeout for a property suite. CI machines are quiet, so failures there are real; locally this
 * machine is shared with heavy workloads, so give properties room (scaled for soak runs) and
 * never let slowness pass for a failed property.
 */
export const propertyTimeout = (): number => {
  const scale = env.FC_NUM_RUNS ? Math.max(1, Number(env.FC_NUM_RUNS) / 2_000) : 1;
  return Math.round((env.CI ? 120_000 : 600_000) * scale);
};

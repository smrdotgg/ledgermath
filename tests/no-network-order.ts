// A Worker's own preload, for tests/no-network.test.ts: records whether the test guard had already run.
(globalThis as Record<string, unknown>).guardRanFirst = (globalThis as Record<symbol, unknown>)[Symbol.for("ledgermath.no-network")] === true;

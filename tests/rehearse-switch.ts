/**
 * Preloaded by tests/public-blobs.test.ts's turn-on rehearsal (`bun test
 * --preload`): sets the public API's switch to LM_PUBLIC_API_STATE and
 * LM_PUBLIC_API_PLAN before any test reads it, as the commit that turns it on
 * would, so the rehearsal shows that only the release gate depends on the
 * committed state. Also preloaded by tests/alarm-telegram.test.ts into the
 * alarm script it runs as a child, to give that script its fixture's state
 * ("off") rather than the committed one. Not a test file.
 */

import { PUBLIC_API } from "../infra/runs/public-blobs";

const state = process.env.LM_PUBLIC_API_STATE;
const plan = process.env.LM_PUBLIC_API_PLAN;
if (state === undefined || plan === undefined) throw new Error("tests/rehearse-switch.ts is preloaded with LM_PUBLIC_API_STATE and LM_PUBLIC_API_PLAN set, and only so");
Object.assign(PUBLIC_API, { state, plan });

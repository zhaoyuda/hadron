// Side-effect import: every test server registers itself under
// HADRON_HOME/servers (`hadron ls --all`). A suite run directly (not through
// run-all.js) would otherwise write throwaway-workspace records into the
// developer's real ~/.hadron and prune that directory at every boot. Import
// this FIRST in any suite that spawns server/index.js; the spawn envs spread
// process.env, so the private dir reaches the server.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.HADRON_HOME = process.env.HADRON_HOME || mkdtempSync(join(tmpdir(), "hadron-home-"));

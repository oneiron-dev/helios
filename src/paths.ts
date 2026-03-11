import { join } from "node:path";
import { homedir } from "node:os";

/** Root config/data directory. Override with HELIOS_HOME env var. */
export const HELIOS_DIR = process.env.HELIOS_HOME ?? join(homedir(), ".helios");

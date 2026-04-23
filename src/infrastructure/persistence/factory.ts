import { PersistenceDriver } from "../../application/contracts";
import { Config, STATE_DRIVERS } from "../../config";
import { logger } from "../../logger";
import { createJsonPersistenceDriver } from "./json-store";
import { createSqlitePersistenceDriver } from "./sqlite-store";

export async function createPersistenceDriver(config: Config): Promise<PersistenceDriver> {
  if (config.stateDriver === STATE_DRIVERS.JSON) {
    logger.info("Persistence driver selected", { driver: STATE_DRIVERS.JSON, path: config.stateJsonPath });
    return createJsonPersistenceDriver(config);
  }

  try {
    const sqliteDriver = await createSqlitePersistenceDriver(config);
    logger.info("Persistence driver selected", { driver: STATE_DRIVERS.SQLITE, path: config.stateDbPath });
    return sqliteDriver;
  } catch (error) {
    logger.error("SQLite unavailable, falling back to JSON persistence", {
      preferredDriver: STATE_DRIVERS.SQLITE,
      fallbackDriver: STATE_DRIVERS.JSON,
      reason: error instanceof Error ? error.message : String(error),
    });

    return createJsonPersistenceDriver(config);
  }
}

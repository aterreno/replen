import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, configureApp } from "./app.module.js";
import { JsonLogger, log } from "./common/logger.js";
import { loadConfig } from "./config.js";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: new JsonLogger(),
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: "20mb" });
  configureApp(app);
  await app.listen(config.port, "127.0.0.1");
  log("info", "replen-api listening", {
    port: config.port,
    database: config.databaseUrl ? "postgres" : `pglite:${config.pgliteDir ?? "memory"}`,
    engine: config.engineUrl,
    erp: config.erpUrl,
    authMode: config.authMode,
  });
}

void bootstrap();

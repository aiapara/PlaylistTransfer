import { env } from "./env.js";
import { createApp, logger } from "./app.js";

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`Backend listening on http://localhost:${env.PORT}`);
});

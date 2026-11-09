import { createProjectWebhookHandler } from "../_shared/project-webhook-handler.ts";
Deno.serve(createProjectWebhookHandler());

/**
 * Root entry point for OpenClaw's direct TypeScript loading (via jiti).
 *
 * Re-exports the plugin from src/index.ts and wraps it with the configSchema
 * and register() method that OpenClaw's plugin-sdk loader expects.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import langfusePlugin from "./dist/index.js";

const plugin = {
  id: langfusePlugin.id,
  name: langfusePlugin.name,
  description: langfusePlugin.description,
  configSchema: {
    type: "object",
    properties: {
      publicKey: {
        type: "string",
        default: "",
        description: "Langfuse public key",
      },
      secretKey: {
        type: "string",
        default: "",
        description: "Langfuse secret key",
      },
      baseUrl: {
        type: "string",
        default: "https://cloud.langfuse.com",
        description: "Langfuse server URL (use self-hosted URL for on-premise)",
      },
      debug: {
        type: "boolean",
        default: false,
        description: "Enable debug logging",
      },
      enabledHooks: {
        type: "array",
        items: { type: "string" },
        description:
          "List of hooks to enable (if not set, all hooks are enabled)",
      },
    },
    required: ["publicKey", "secretKey"],
  },

  register(api: OpenClawPluginApi) {
    (langfusePlugin as any).activate(api);
  },
};

export default plugin;

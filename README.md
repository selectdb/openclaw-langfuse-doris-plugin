# openclaw-langfuse-plugin

OpenClaw plugin for reporting AI agent execution traces to [Langfuse](https://langfuse.com). Captures full agent lifecycle including LLM calls, tool executions, messages, and session events.

## Install

### From GitHub (latest)

```bash
# Clone to OpenClaw extensions directory
git clone https://github.com/selectdb/openclaw-langfuse-doris-plugin.git \
  ~/.openclaw/extensions/openclaw-langfuse-plugin

# Install dependencies
cd ~/.openclaw/extensions/openclaw-langfuse-plugin && npm install
```

### From npm

```bash
openclaw plugins install openclaw-langfuse-plugin
```

> **Note:** The npm version may lag behind the GitHub repository. For the latest features and fixes, install from GitHub.

## Configure

Edit `~/.openclaw/openclaw.json` to add the plugin configuration:

### Single Langfuse target

```jsonc
{
  "plugins": {
    "allow": ["openclaw-langfuse-plugin"],
    "entries": {
      "openclaw-langfuse-plugin": {
        "enabled": true,
        "config": {
          "publicKey": "pk-lf-xxx",
          "secretKey": "sk-lf-xxx",
          "baseUrl": "http://your-langfuse:3000"
        }
      }
    }
  }
}
```

### Multiple Langfuse targets

Send traces to multiple Langfuse instances simultaneously. All targets receive identical trace and observation IDs for cross-instance data comparison.

```jsonc
{
  "plugins": {
    "allow": ["openclaw-langfuse-plugin"],
    "entries": {
      "openclaw-langfuse-plugin": {
        "enabled": true,
        "config": {
          "targets": [
            {
              "name": "production",
              "publicKey": "pk-lf-xxx",
              "secretKey": "sk-lf-xxx",
              "baseUrl": "http://langfuse-prod:3000"
            },
            {
              "name": "analytics",
              "publicKey": "pk-lf-yyy",
              "secretKey": "sk-lf-yyy",
              "baseUrl": "http://langfuse-analytics:3000"
            }
          ],
          "tags": ["openclaw", "my-instance"],
          "environment": "production"
        }
      }
    }
  }
}
```

### Apply configuration

```bash
openclaw gateway restart
```

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `publicKey` | string | — | Langfuse public key (single target mode) |
| `secretKey` | string | — | Langfuse secret key (single target mode) |
| `baseUrl` | string | `https://cloud.langfuse.com` | Langfuse server URL |
| `targets` | array | — | Multiple Langfuse targets (overrides single key config) |
| `tags` | string[] | `["openclaw"]` | Tags attached to all Langfuse traces (e.g. instance name, team) |
| `environment` | string | `"default"` | Langfuse environment label (e.g. production, staging, development) |
| `userId` | string | — | userId prefix on traces (e.g. `"alice"` → `alice/openclaw-tui`) |
| `debug` | boolean | `false` | Enable debug logging |
| `enabledHooks` | string[] | all | List of hooks to enable |

### Available Hooks

`session_start`, `session_end`, `message_received`, `message_sending`, `message_sent`, `llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, `before_agent_start`, `agent_end`, `gateway_start`

## What Gets Captured

| Data | Source Hook | Level |
|------|------------|-------|
| User input | `message_received` | Full content |
| LLM system prompt | `llm_input` | Full content |
| LLM conversation history | `llm_input` | Full messages |
| LLM response | `llm_output` | Full text + usage |
| Tool call params & results | `before/after_tool_call` | Full content |
| Agent duration & stats | `agent_end` | Metrics |
| Session lifecycle | `session_start/end` | Events |

### Token Usage & Cost

For Anthropic models, the plugin reports accurate token breakdown including cache metrics:

- `input` — non-cached input tokens
- `output` — output tokens
- `cache_read_input_tokens` — tokens read from prompt cache
- `cache_creation_input_tokens` — tokens written to prompt cache

Langfuse calculates cost from its model pricing definitions, with per-tier pricing for cached vs non-cached tokens.

## Update

### From GitHub

```bash
cd ~/.openclaw/extensions/openclaw-langfuse-plugin && git pull && npm install
openclaw gateway restart
```

### From npm

```bash
openclaw plugins update
```

## Uninstall

```bash
# If installed from GitHub
rm -rf ~/.openclaw/extensions/openclaw-langfuse-plugin

# If installed from npm
openclaw plugins uninstall openclaw-langfuse-plugin
```

## License

Apache-2.0

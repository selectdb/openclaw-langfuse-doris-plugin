# openclaw-langfuse-plugin

OpenClaw plugin for reporting AI agent execution traces to [Langfuse](https://langfuse.com). Captures full agent lifecycle including LLM calls, tool executions, messages, and session events.

## Install

```bash
openclaw plugins install openclaw-langfuse-plugin
```

## Configure

Add the plugin config to your `openclaw.json`:

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

Send traces to multiple Langfuse instances simultaneously:

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
          ]
        }
      }
    }
  }
}
```

### Or via CLI

```bash
openclaw plugins enable openclaw-langfuse-plugin
```

Then edit `~/.openclaw/openclaw.json` to add your Langfuse credentials.

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `publicKey` | string | — | Langfuse public key (single target mode) |
| `secretKey` | string | — | Langfuse secret key (single target mode) |
| `baseUrl` | string | `https://cloud.langfuse.com` | Langfuse server URL |
| `targets` | array | — | Multiple Langfuse targets (overrides single key config) |
| `tags` | string[] | `["openclaw"]` | Tags attached to all Langfuse traces (e.g. instance name, team) |
| `environment` | string | `"default"` | Langfuse environment label (e.g. production, staging, development) |
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

## Update

```bash
openclaw plugins update
```

## Uninstall

```bash
openclaw plugins uninstall openclaw-langfuse-plugin
```

## License

Apache-2.0

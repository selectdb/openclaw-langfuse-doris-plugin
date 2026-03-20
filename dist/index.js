import { LangfuseExporter } from "./langfuse-exporter.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateId(length = 16) {
    const chars = "0123456789abcdef";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}
function safeClone(value) {
    if (typeof globalThis.structuredClone === "function") {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}
const MAX_ATTR_LENGTH = 3_200_000;
function truncateAttr(value) {
    return value.length > MAX_ATTR_LENGTH
        ? value.substring(0, MAX_ATTR_LENGTH)
        : value;
}
function toSpecParts(content) {
    if (content === undefined || content === null)
        return [];
    if (typeof content === "string") {
        return [{ type: "text", content }];
    }
    if (Array.isArray(content)) {
        return content.map((item) => {
            if (typeof item === "string") {
                return { type: "text", content: item };
            }
            if (typeof item === "object" && item !== null) {
                const obj = item;
                if (obj.type === "toolCall" || obj.type === "tool_call" || obj.type === "function_call") {
                    return {
                        type: "tool_call",
                        id: obj.id || obj.toolCallId || null,
                        name: obj.name || obj.toolName || "",
                        arguments: obj.arguments || obj.input || obj.params || null,
                    };
                }
                if (obj.type === "toolResult" || obj.type === "tool_result" || obj.type === "tool_call_response") {
                    const resp = obj.response ?? obj.result ?? obj.content ?? "";
                    return {
                        type: "tool_call_response",
                        id: obj.id || obj.toolCallId || null,
                        response: typeof resp === "string" ? resp : JSON.stringify(resp),
                    };
                }
                if (obj.type === "text") {
                    return { type: "text", content: String(obj.content ?? obj.text ?? "") };
                }
                if (obj.type === "thinking" || obj.type === "reasoning") {
                    return { type: "reasoning", content: String(obj.content ?? obj.thinking ?? "") };
                }
                if (obj.type)
                    return obj;
                return { type: "text", content: JSON.stringify(item) };
            }
            return { type: "text", content: String(item) };
        });
    }
    return [{ type: "text", content: JSON.stringify(content) }];
}
function formatSystemInstructions(systemPrompt) {
    return truncateAttr(JSON.stringify([{ type: "text", content: systemPrompt }]));
}
const ROLE_MAP = {
    toolResult: "tool",
    tool_result: "tool",
    function: "tool",
};
function formatInputMessages(historyMessages, userPrompt) {
    const result = [];
    for (const msg of historyMessages) {
        const role = ROLE_MAP[msg.role] || msg.role;
        result.push({ role, parts: toSpecParts(msg.content) });
    }
    if (userPrompt) {
        result.push({ role: "user", parts: [{ type: "text", content: userPrompt }] });
    }
    return truncateAttr(JSON.stringify(result));
}
function formatOutputMessages(assistantTexts, finishReason = "stop") {
    return truncateAttr(JSON.stringify(assistantTexts.map((text) => ({
        role: "assistant",
        parts: [{ type: "text", content: text }],
        finish_reason: finishReason,
    }))));
}
function normalizeChannelId(input) {
    if (!input || input === "unknown")
        return "system/unknown";
    if (input.includes("/"))
        return input;
    if (/^agent[_:]/.test(input))
        return `agent/${input.slice(6)}`;
    return `system/${input}`;
}
function resolveChannelId(ctx, eventFrom) {
    const raw = ctx.sessionKey ||
        ctx.channelId ||
        ctx.conversationId ||
        eventFrom ||
        "unknown";
    return normalizeChannelId(raw);
}
export const langfusePlugin = {
    id: "openclaw-langfuse-plugin",
    name: "OpenClaw Langfuse Plugin",
    version: "0.1.0",
    description: "Report OpenClaw AI agent execution traces to Langfuse",
    activate(api) {
        const pluginConfig = (api.pluginConfig || {});
        // When using targets array, publicKey/secretKey are optional at top level
        if (!pluginConfig.targets && !pluginConfig.publicKey) {
            api.logger.error("[Langfuse] Missing required configuration: 'publicKey' or 'targets' must be provided");
            return;
        }
        if (!pluginConfig.targets && !pluginConfig.secretKey) {
            api.logger.error("[Langfuse] Missing required configuration: 'secretKey' or 'targets' must be provided");
            return;
        }
        const config = {
            publicKey: pluginConfig.publicKey,
            secretKey: pluginConfig.secretKey,
            baseUrl: pluginConfig.baseUrl,
            debug: pluginConfig.debug || false,
            enabledHooks: pluginConfig.enabledHooks,
            targets: pluginConfig.targets,
        };
        const exporter = new LangfuseExporter(api, config);
        // -- Trace context management -------------------------------------------
        const contextByChannelId = new Map();
        const contextByRunId = new Map();
        let lastUserChannelId;
        let lastUserTraceContext;
        let lastUserContextSetAt;
        let pendingToolCall;
        let lastLlmSystemInstructions;
        let lastLlmInputMessages;
        let lastLlmStartTime;
        let lastLlmSpanId;
        const openclawVersion = api.runtime?.version || "unknown";
        const shouldHookEnabled = (hookName) => {
            if (!config.enabledHooks)
                return true;
            return config.enabledHooks.includes(hookName);
        };
        const getContextByChannel = (channelId) => contextByChannelId.get(channelId);
        const getContextByRun = (runId) => contextByRunId.get(runId);
        const getOriginalChannelId = (runId) => {
            const ctx = contextByRunId.get(runId);
            return ctx?.originalChannelId || ctx?.channelId;
        };
        const startTurn = (runId, channelId, originalChannelId) => {
            const traceId = generateId(32);
            const ctx = {
                traceId,
                rootSpanId: generateId(16),
                runId,
                turnId: runId,
                channelId,
                originalChannelId: originalChannelId || channelId,
            };
            contextByChannelId.set(channelId, ctx);
            contextByRunId.set(runId, ctx);
            return ctx;
        };
        const endTurn = (channelId) => {
            const ctx = contextByChannelId.get(channelId);
            if (ctx) {
                contextByChannelId.delete(channelId);
                contextByRunId.delete(ctx.runId);
            }
        };
        const getOrCreateContext = (rawChannelId, runId, hookName) => {
            let channelId = rawChannelId;
            let activeCtx = getContextByChannel(rawChannelId);
            const effectiveRunId = runId || activeCtx?.runId || `run-${Date.now()}`;
            if (rawChannelId.startsWith("agent/") && effectiveRunId) {
                const originalChannelId = getOriginalChannelId(effectiveRunId);
                if (originalChannelId) {
                    channelId = originalChannelId;
                    activeCtx = getContextByChannel(originalChannelId) || activeCtx;
                }
            }
            if (!activeCtx) {
                activeCtx = getContextByRun(effectiveRunId);
            }
            if (!activeCtx &&
                rawChannelId.startsWith("agent/") &&
                lastUserTraceContext &&
                lastUserContextSetAt &&
                Date.now() - lastUserContextSetAt < 3000) {
                activeCtx = lastUserTraceContext;
                channelId = lastUserChannelId || channelId;
                contextByChannelId.set(rawChannelId, activeCtx);
                contextByRunId.set(effectiveRunId, activeCtx);
                if (config.debug) {
                    api.logger.info(`[Langfuse] LINKING agent to user context: hook=${hookName}, agentChannel=${rawChannelId}, userChannel=${channelId}, traceId=${activeCtx.traceId}`);
                }
            }
            let isNew = false;
            if (!activeCtx) {
                activeCtx = startTurn(effectiveRunId, channelId, rawChannelId !== channelId ? rawChannelId : undefined);
                isNew = true;
                if (config.debug) {
                    api.logger.info(`[Langfuse] NEW TraceContext: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}, traceId=${activeCtx.traceId}`);
                }
            }
            else if (config.debug) {
                api.logger.info(`[Langfuse] REUSING TraceContext: hook=${hookName}, channelId=${channelId}, traceId=${activeCtx.traceId}`);
            }
            return { ctx: activeCtx, channelId, isNew };
        };
        const createSpan = (ctx, channelId, name, type, startTime, endTime, attributes = {}, input, output, parentSpanId) => ({
            name,
            type,
            startTime,
            endTime,
            attributes: {
                ...attributes,
                "openclaw.version": openclawVersion,
                "openclaw.session.id": ctx.sessionId || channelId,
                "gen_ai.session.id": ctx.sessionId || channelId,
                "openclaw.run.id": ctx.runId,
                "openclaw.turn.id": ctx.turnId,
                "openclaw.channel.id": channelId,
            },
            input,
            output,
            traceId: ctx.traceId,
            spanId: generateId(16),
            parentSpanId: parentSpanId || ctx.rootSpanId,
        });
        const ensureEntrySpan = async (ctx, channelId, options = {}) => {
            if (ctx.rootSpanStartTime)
                return;
            const now = Date.now();
            ctx.rootSpanStartTime = now;
            const rootSpanData = {
                name: "enter_openclaw_system",
                type: "entry",
                startTime: now,
                attributes: {
                    "gen_ai.operation.name": "enter",
                    "gen_ai.user.id": options.userId || "unknown",
                    "openclaw.session.id": ctx.sessionId || channelId,
                    "gen_ai.session.id": ctx.sessionId || channelId,
                    "openclaw.run.id": ctx.runId,
                    "openclaw.turn.id": ctx.turnId,
                    "openclaw.message.role": options.role || "unknown",
                    "openclaw.message.from": options.from || "unknown",
                    "openclaw.version": openclawVersion,
                },
                input: ctx.userInput,
                traceId: ctx.traceId,
                spanId: ctx.rootSpanId,
            };
            await exporter.startSpan(rootSpanData, ctx.rootSpanId);
            if (config.debug) {
                api.logger.info(`[Langfuse] Started root span: traceId=${ctx.traceId}, spanId=${ctx.rootSpanId}`);
            }
        };
        // -- Hook: gateway_stop -------------------------------------------------
        api.on("gateway_stop", async () => {
            await exporter.dispose();
        });
        // -- Hook: gateway_start ------------------------------------------------
        if (shouldHookEnabled("gateway_start")) {
            api.on("gateway_start", async (event) => {
                const now = Date.now();
                const { ctx, channelId } = getOrCreateContext("system/gateway", undefined, "gateway_start");
                const span = createSpan(ctx, channelId, "gateway_start", "gateway", now, now, {
                    "gateway.version": event.version || "unknown",
                    "gateway.working_dir": event.workingDir || process.cwd(),
                });
                delete span.attributes["openclaw.session.id"];
                delete span.attributes["gen_ai.session.id"];
                await exporter.export(span);
            });
        }
        // -- Hook: session_start ------------------------------------------------
        if (shouldHookEnabled("session_start")) {
            api.on("session_start", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "session_start");
                const now = Date.now();
                const span = createSpan(ctx, channelId, "session_start", "session", now, now, {
                    "event.type": "session_start",
                });
                delete span.attributes["gen_ai.session.id"];
                if (event.sessionId) {
                    span.attributes["openclaw.session.id"] = event.sessionId;
                }
                await exporter.export(span);
            });
        }
        // -- Hook: session_end --------------------------------------------------
        if (shouldHookEnabled("session_end")) {
            api.on("session_end", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "session_end");
                const now = Date.now();
                const span = createSpan(ctx, channelId, "session_end", "session", now, now, {
                    "session.duration_ms": event.duration || 0,
                    "session.message_count": event.messageCount || 0,
                    "session.total_tokens": event.totalTokens || 0,
                }, undefined, {
                    messageCount: event.messageCount,
                    totalTokens: event.totalTokens,
                });
                delete span.attributes["gen_ai.session.id"];
                if (event.sessionId) {
                    span.attributes["openclaw.session.id"] = event.sessionId;
                }
                await exporter.export(span);
                endTurn(channelId);
            });
        }
        // -- Hook: message_received ---------------------------------------------
        if (shouldHookEnabled("message_received")) {
            api.on("message_received", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx, event.from || event.metadata?.senderId);
                const { ctx, channelId, isNew } = getOrCreateContext(rawChannelId, undefined, "message_received");
                const now = Date.now();
                let role = event.role;
                if (!role && event.from)
                    role = "user";
                const isUserMessage = !rawChannelId.startsWith("agent/");
                if (isUserMessage) {
                    if (!role)
                        role = "user";
                    lastUserChannelId = channelId;
                    lastUserTraceContext = ctx;
                    lastUserContextSetAt = Date.now();
                    ctx.userInput = event.content;
                    await ensureEntrySpan(ctx, channelId, {
                        userId: event.from || event.metadata?.senderId,
                        role: role || "user",
                        from: event.from,
                    });
                }
            });
        }
        // -- Hook: message_sending ----------------------------------------------
        if (shouldHookEnabled("message_sending")) {
            api.on("message_sending", async (event, _hookCtx) => {
                if (lastUserTraceContext) {
                    lastUserTraceContext.lastOutput = event.content;
                }
                else {
                    const rawChannelId = resolveChannelId(_hookCtx, event.to);
                    const { ctx } = getOrCreateContext(rawChannelId, undefined, "message_sending");
                    ctx.lastOutput = event.content;
                }
            });
        }
        // -- Hook: message_sent -------------------------------------------------
        if (shouldHookEnabled("message_sent")) {
            api.on("message_sent", async (event, hookCtx) => {
                if (event.content && event.success) {
                    if (lastUserTraceContext) {
                        lastUserTraceContext.lastOutput = event.content;
                    }
                    else {
                        const rawChannelId = resolveChannelId(hookCtx, event.to);
                        const { ctx } = getOrCreateContext(rawChannelId, undefined, "message_sent");
                        ctx.lastOutput = event.content;
                    }
                }
            });
        }
        // -- Hook: llm_input ----------------------------------------------------
        if (shouldHookEnabled("llm_input")) {
            api.on("llm_input", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const { ctx } = getOrCreateContext(rawChannelId, event.runId, "llm_input");
                if (event.sessionId) {
                    ctx.sessionId = event.sessionId;
                }
                if (!ctx.userInput && event.prompt) {
                    ctx.userInput = event.prompt;
                }
                ctx.llmStartTime = Date.now();
                ctx.llmSpanId = generateId(16);
                if (event.systemPrompt) {
                    ctx.llmSystemInstructions = formatSystemInstructions(event.systemPrompt);
                }
                const historyMsgs = event.historyMessages?.length
                    ? event.historyMessages.map((msg) => safeClone(msg))
                    : [];
                ctx.llmInputMessages = formatInputMessages(historyMsgs, event.prompt);
                lastLlmSystemInstructions = ctx.llmSystemInstructions;
                lastLlmInputMessages = ctx.llmInputMessages;
                lastLlmStartTime = ctx.llmStartTime;
                lastLlmSpanId = ctx.llmSpanId;
                if (config.debug) {
                    api.logger.info(`[Langfuse] LLM input started: ${event.provider}/${event.model}, runId=${event.runId}`);
                }
            });
        }
        // -- Hook: llm_output ---------------------------------------------------
        if (shouldHookEnabled("llm_output")) {
            api.on("llm_output", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const { ctx, channelId } = getOrCreateContext(rawChannelId, event.runId, "llm_output");
                if (event.sessionId) {
                    ctx.sessionId = event.sessionId;
                }
                const now = Date.now();
                const startTime = ctx.llmStartTime || lastLlmStartTime || now;
                if (event.assistantTexts?.length) {
                    const outputText = event.assistantTexts.join("\n");
                    ctx.lastOutput = outputText;
                    if (lastUserTraceContext) {
                        lastUserTraceContext.lastOutput = outputText;
                    }
                }
                const systemInstructions = ctx.llmSystemInstructions || lastLlmSystemInstructions;
                const inputMessages = ctx.llmInputMessages || lastLlmInputMessages;
                const llmSpanId = ctx.llmSpanId || lastLlmSpanId;
                const lastAssistantUsage = event.lastAssistant?.usage;
                const inputTokens = event.usage?.input ?? lastAssistantUsage?.input ?? 0;
                const outputTokens = event.usage?.output ?? lastAssistantUsage?.output ?? 0;
                const cacheReadTokens = event.usage?.cacheRead ?? 0;
                const cacheCreationTokens = event.usage?.cacheWrite ?? 0;
                const lastAssistantObj = event.lastAssistant;
                const stopReason = typeof lastAssistantObj?.stopReason === "string" ? lastAssistantObj.stopReason : undefined;
                const llmAttrs = {
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": event.provider,
                    "gen_ai.request.model": event.model,
                    "gen_ai.response.model": event.model,
                    "gen_ai.usage.input_tokens": inputTokens,
                    "gen_ai.usage.output_tokens": outputTokens,
                    "gen_ai.usage.total_tokens": inputTokens + outputTokens,
                    "gen_ai.usage.cache_read.input_tokens": cacheReadTokens,
                    "gen_ai.usage.cache_creation.input_tokens": cacheCreationTokens,
                };
                if (stopReason) {
                    llmAttrs["gen_ai.response.finish_reasons"] = JSON.stringify([stopReason]);
                }
                if (systemInstructions) {
                    llmAttrs["gen_ai.system_instructions"] = systemInstructions;
                }
                if (inputMessages) {
                    llmAttrs["gen_ai.input.messages"] = inputMessages;
                }
                if (event.assistantTexts?.length) {
                    llmAttrs["gen_ai.output.messages"] = formatOutputMessages(event.assistantTexts, stopReason || "stop");
                }
                const span = createSpan(ctx, channelId, `chat ${event.model}`, "model", startTime, now, llmAttrs);
                if (llmSpanId)
                    span.spanId = llmSpanId;
                ctx.llmStartTime = undefined;
                ctx.llmSpanId = undefined;
                ctx.llmSystemInstructions = undefined;
                ctx.llmInputMessages = undefined;
                lastLlmSystemInstructions = undefined;
                lastLlmInputMessages = undefined;
                lastLlmStartTime = undefined;
                lastLlmSpanId = undefined;
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[Langfuse] Exported LLM span: ${event.provider}/${event.model}, duration=${now - startTime}ms`);
                }
            });
        }
        // -- Hook: before_tool_call ---------------------------------------------
        if (shouldHookEnabled("before_tool_call")) {
            api.on("before_tool_call", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "before_tool_call");
                pendingToolCall = {
                    toolName: event.toolName,
                    toolCallId: `call_${generateId(12)}`,
                    toolSpanId: generateId(16),
                    toolStartTime: Date.now(),
                    toolInput: event.params,
                    traceContext: ctx,
                    channelId,
                };
                if (config.debug) {
                    api.logger.info(`[Langfuse] Tool call started: ${event.toolName}, spanId=${pendingToolCall.toolSpanId}`);
                }
            });
        }
        // -- Hook: after_tool_call ----------------------------------------------
        if (shouldHookEnabled("after_tool_call")) {
            api.on("after_tool_call", async (event, _hookCtx) => {
                if (!pendingToolCall || pendingToolCall.toolName !== event.toolName) {
                    return;
                }
                const { toolName, toolCallId, toolSpanId, toolStartTime, toolInput, traceContext, channelId } = pendingToolCall;
                pendingToolCall = undefined;
                const now = Date.now();
                const toolAttrs = {
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": toolName,
                    "gen_ai.tool.call.id": toolCallId,
                    "gen_ai.tool.type": "function",
                    "tool.duration_ms": event.durationMs || now - toolStartTime,
                };
                if (toolInput !== undefined) {
                    toolAttrs["gen_ai.tool.call.arguments"] = truncateAttr(typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput));
                }
                if (event.error) {
                    toolAttrs["error.type"] = event.error;
                }
                else if (event.result !== undefined) {
                    toolAttrs["gen_ai.tool.call.result"] = truncateAttr(typeof event.result === "string" ? event.result : JSON.stringify(event.result));
                }
                const span = createSpan(traceContext, channelId, `execute_tool ${toolName}`, "tool", toolStartTime, now, toolAttrs);
                span.spanId = toolSpanId;
                await exporter.export(span);
                if (config.debug) {
                    api.logger.info(`[Langfuse] Exported tool span: ${toolName}, duration=${now - toolStartTime}ms`);
                }
            });
        }
        // -- Hook: before_agent_start -------------------------------------------
        if (shouldHookEnabled("before_agent_start")) {
            api.on("before_agent_start", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const agentId = hookCtx.agentId || event.agentId || "openclaw";
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "before_agent_start");
                // Ensure ENTRY span exists (idempotent: skips if message_received already created one)
                await ensureEntrySpan(ctx, channelId, {
                    userId: hookCtx.trigger || "system",
                    role: hookCtx.trigger || "system",
                    from: agentId,
                });
                if (ctx.agentSpanId)
                    return;
                const now = Date.now();
                ctx.agentStartTime = now;
                ctx.agentSpanId = generateId(16);
                const spanData = {
                    name: `invoke_agent ${agentId}`,
                    type: "agent",
                    startTime: now,
                    attributes: {
                        "gen_ai.operation.name": "invoke_agent",
                        "gen_ai.provider.name": "openclaw",
                        "gen_ai.agent.id": agentId,
                        "gen_ai.agent.name": agentId,
                        "openclaw.session.id": ctx.sessionId || channelId,
                        "gen_ai.session.id": ctx.sessionId || channelId,
                        "openclaw.run.id": ctx.runId,
                        "openclaw.turn.id": ctx.turnId,
                        "openclaw.version": openclawVersion,
                    },
                    traceId: ctx.traceId,
                    spanId: ctx.agentSpanId,
                    parentSpanId: ctx.rootSpanId,
                };
                await exporter.startSpan(spanData, ctx.agentSpanId);
                if (config.debug) {
                    api.logger.info(`[Langfuse] Started agent span: ${agentId}, spanId=${ctx.agentSpanId}`);
                }
            });
        }
        // -- Hook: agent_end ----------------------------------------------------
        if (shouldHookEnabled("agent_end")) {
            api.on("agent_end", async (event, hookCtx) => {
                const rawChannelId = resolveChannelId(hookCtx);
                const { ctx, channelId } = getOrCreateContext(rawChannelId, undefined, "agent_end");
                const now = Date.now();
                // Collect agent span closing data (defer actual close to setTimeout)
                const pendingAgentSpanId = ctx.agentSpanId;
                const agentEndTime = now;
                let agentEndAttrs;
                if (pendingAgentSpanId) {
                    agentEndAttrs = {
                        "agent.duration_ms": event.durationMs || 0,
                        "agent.message_count": event.messageCount || 0,
                        "agent.tool_call_count": event.toolCallCount || 0,
                        "gen_ai.usage.input_tokens": event.usage?.input || 0,
                        "gen_ai.usage.output_tokens": event.usage?.output || 0,
                    };
                    if (ctx.sessionId) {
                        agentEndAttrs["openclaw.session.id"] = ctx.sessionId || channelId;
                        agentEndAttrs["gen_ai.session.id"] = ctx.sessionId || channelId;
                    }
                    const agentInput = ctx.userInput || lastUserTraceContext?.userInput;
                    if (agentInput) {
                        agentEndAttrs["gen_ai.input.messages"] = truncateAttr(JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(agentInput) }] }]));
                    }
                    ctx.agentSpanId = undefined;
                    ctx.agentStartTime = undefined;
                }
                const agentUsageCost = pendingAgentSpanId ? { usage: event.usage, cost: event.cost } : undefined;
                // Snapshot references before clearing global pointers.
                const savedLastUserTraceContext = lastUserTraceContext;
                const savedLastUserChannelId = lastUserChannelId;
                const originalChannelId = ctx.originalChannelId || savedLastUserChannelId || channelId;
                // Clear global pointers immediately
                lastUserChannelId = undefined;
                lastUserTraceContext = undefined;
                lastUserContextSetAt = undefined;
                const rootCtx = savedLastUserTraceContext || ctx;
                const agentChannelId = channelId;
                if (rootCtx.rootSpanStartTime || pendingAgentSpanId) {
                    const rootSpanId = rootCtx.rootSpanId;
                    const rootSpanStartTime = rootCtx.rootSpanStartTime;
                    const userInput = rootCtx.userInput;
                    const traceId = rootCtx.traceId;
                    const resolvedSessionId = ctx.sessionId || rootCtx.sessionId;
                    setTimeout(async () => {
                        // By now llm_output / message_sending / message_sent should have executed
                        const finalOutput = ctx.lastOutput || rootCtx.lastOutput;
                        // End agent span (deferred)
                        if (pendingAgentSpanId && agentEndAttrs) {
                            if (finalOutput) {
                                agentEndAttrs["gen_ai.output.messages"] = formatOutputMessages([
                                    typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
                                ]);
                            }
                            exporter.endSpanById(pendingAgentSpanId, agentEndTime, agentEndAttrs, finalOutput, undefined);
                            if (config.debug) {
                                api.logger.info(`[Langfuse] Ended agent span: spanId=${pendingAgentSpanId}, duration=${event.durationMs}ms`);
                            }
                        }
                        // End root span
                        if (rootSpanStartTime) {
                            const endTime = Date.now();
                            const rootEndAttrs = {
                                "request.duration_ms": endTime - rootSpanStartTime,
                            };
                            if (resolvedSessionId) {
                                rootEndAttrs["openclaw.session.id"] = resolvedSessionId;
                                rootEndAttrs["gen_ai.session.id"] = resolvedSessionId;
                            }
                            if (userInput) {
                                rootEndAttrs["gen_ai.input.messages"] = truncateAttr(JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(userInput) }] }]));
                            }
                            if (finalOutput) {
                                rootEndAttrs["gen_ai.output.messages"] = formatOutputMessages([
                                    typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
                                ]);
                            }
                            exporter.endSpanById(rootSpanId, endTime, rootEndAttrs, finalOutput, userInput);
                            if (config.debug) {
                                api.logger.info(`[Langfuse] Ended root span: spanId=${rootSpanId}, duration=${endTime - rootSpanStartTime}ms, traceId=${traceId}`);
                            }
                        }
                        // Clean up Map entries
                        if (savedLastUserChannelId)
                            endTurn(savedLastUserChannelId);
                        if (originalChannelId && originalChannelId !== savedLastUserChannelId) {
                            endTurn(originalChannelId);
                        }
                        if (rawChannelId !== originalChannelId && rawChannelId !== savedLastUserChannelId) {
                            contextByChannelId.delete(rawChannelId);
                        }
                        await exporter.flush();
                        exporter.endTrace();
                    }, 100);
                }
                else {
                    if (savedLastUserChannelId)
                        endTurn(savedLastUserChannelId);
                    if (originalChannelId && originalChannelId !== savedLastUserChannelId) {
                        endTurn(originalChannelId);
                    }
                    if (rawChannelId !== originalChannelId && rawChannelId !== savedLastUserChannelId) {
                        contextByChannelId.delete(rawChannelId);
                    }
                    await exporter.flush();
                    exporter.endTrace();
                }
            });
        }
        api.logger.info(`[Langfuse] Plugin activated (baseUrl: ${config.baseUrl || "cloud.langfuse.com"})`);
    },
};
export default langfusePlugin;
//# sourceMappingURL=index.js.map
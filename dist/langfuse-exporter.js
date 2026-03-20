import { Langfuse } from "langfuse";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

// Direct fetch using node:http/https — completely bypasses global-agent proxy patching
const directHttpAgent = new http.Agent({ keepAlive: true });
const directHttpsAgent = new https.Agent({ keepAlive: true });

function directFetch(url, init = {}) {
    const parsedUrl = new URL(typeof url === "string" ? url : url.toString());
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;
    const agent = isHttps ? directHttpsAgent : directHttpAgent;

    return new Promise((resolve, reject) => {
        const method = (init.method || "GET").toUpperCase();
        const headers = {};
        if (init.headers) {
            if (typeof init.headers.forEach === "function") {
                init.headers.forEach((v, k) => { headers[k] = v; });
            } else if (typeof init.headers === "object") {
                Object.assign(headers, init.headers);
            }
        }
        const body = init.body ?? null;
        if (body && !headers["content-length"] && typeof body === "string") {
            headers["content-length"] = Buffer.byteLength(body);
        }

        const req = lib.request(parsedUrl, { method, headers, agent, timeout: 30000 }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const buf = Buffer.concat(chunks);
                const text = buf.toString("utf-8");
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusText: res.statusMessage || "",
                    headers: new Headers(Object.entries(res.headers).filter(([,v]) => v != null).map(([k,v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
                    text: () => Promise.resolve(text),
                    json: () => Promise.resolve(JSON.parse(text)),
                    body: null,
                });
            });
        });

        req.on("error", reject);
        req.on("timeout", () => { req.destroy(new Error("Request timeout")); });
        if (init.signal) {
            init.signal.addEventListener("abort", () => req.destroy(new Error("Aborted")), { once: true });
        }
        if (body) { req.write(body); }
        req.end();
    });
}

function createLangfuseClient(target) {
    const client = new Langfuse({
        publicKey: target.publicKey,
        secretKey: target.secretKey,
        baseUrl: target.baseUrl || "https://cloud.langfuse.com",
        requestTimeout: 30000,
    });
    client.fetch = directFetch;
    return client;
}

// ---------------------------------------------------------------------------
// Multi-target LangfuseExporter
// Each Langfuse client gets its own traceMap/spanMap so IDs don't collide.
// ---------------------------------------------------------------------------

class SingleTargetExporter {
    constructor(api, target, label) {
        this.api = api;
        this.label = label;
        this.langfuse = createLangfuseClient(target);
        this.traceMap = new Map();
        this.spanMap = new Map();
        // Maps traceId -> active agent span client (for nesting children under agent)
        this.agentSpanMap = new Map();
        this.debug = target.debug || false;
    }

    getOrCreateTrace(traceId, metadata = {}) {
        let trace = this.traceMap.get(traceId);
        if (!trace) {
            trace = this.langfuse.trace({
                name: `openclaw-${traceId.slice(0, 8)}`,
                metadata: { ...metadata, source: "openclaw-plugin" },
            });
            this.traceMap.set(traceId, trace);
        }
        return trace;
    }

    updateTrace(traceId, updates = {}) {
        const trace = this.traceMap.get(traceId);
        if (trace) {
            trace.update(updates);
        }
    }

    // Get the parent to nest under: agent span if exists, otherwise trace
    _getParent(traceId) {
        const agentSpan = this.agentSpanMap.get(traceId);
        if (agentSpan) {
            this.api.logger.info(`[Langfuse:${this.label}] _getParent: using agent span (observationId=${agentSpan.observationId}) for traceId=${traceId}`);
            return agentSpan;
        }
        this.api.logger.info(`[Langfuse:${this.label}] _getParent: NO agent span found, falling back to trace for traceId=${traceId}`);
        return this.traceMap.get(traceId);
    }

    async startSpan(spanData, customSpanId) {
        const trace = this.getOrCreateTrace(spanData.traceId, {
            channelId: spanData.attributes?.["openclaw.channel.id"],
        });
        const spanId = customSpanId || spanData.spanId;
        const startTime = new Date(spanData.startTime);
        if (spanData.type === "entry" || !spanData.parentSpanId) {
            // Skip creating entry events — they create flat siblings that break the graph.
            // Trace metadata is already on the trace object. Just record the spanId for endSpanById.
            this.spanMap.set(spanId, { type: "event", obj: null, trace });
        } else if (spanData.type === "agent") {
            // Agent span: create under trace, save client for nesting children
            const span = trace.span({ name: spanData.name, startTime, metadata: spanData.attributes, input: spanData.input });
            this.spanMap.set(spanId, { type: "span", obj: span, trace });
            this.agentSpanMap.set(spanData.traceId, span);
        } else if (spanData.type === "model") {
            // Generation: nest under agent span if available
            const parent = this._getParent(spanData.traceId);
            const generation = parent.generation({
                name: spanData.name,
                model: spanData.attributes?.["gen_ai.request.model"] || "unknown",
                startTime, metadata: spanData.attributes,
                input: parseInput(spanData.attributes),
                output: parseOutput(spanData.attributes),
            });
            this.spanMap.set(spanId, { type: "generation", obj: generation, trace });
        }
    }

    endSpanById(spanId, endTime, additionalAttrs, output, _input) {
        const spanInfo = this.spanMap.get(spanId);
        if (!spanInfo) {
            this.api.logger.info(`[Langfuse:${this.label}] endSpanById: spanId=${spanId} NOT FOUND in spanMap (keys: ${[...this.spanMap.keys()].join(', ')})`);
            return;
        }
        this.api.logger.info(`[Langfuse:${this.label}] endSpanById: spanId=${spanId} type=${spanInfo.type} langfuseId=${spanInfo.obj?.id}`);
        if (spanInfo.type === "generation" && spanInfo.obj) {
            if (additionalAttrs) {
                spanInfo.obj.update({ metadata: additionalAttrs, output: output || parseOutput(additionalAttrs) });
            }
            spanInfo.obj.end();
            this.api.logger.info(`[Langfuse:${this.label}] called generation.end() for id=${spanInfo.obj.id}`);
        } else if (spanInfo.type === "span" && spanInfo.obj) {
            if (additionalAttrs) {
                spanInfo.obj.update({ metadata: additionalAttrs, output: output || undefined });
            }
            spanInfo.obj.end();
            this.api.logger.info(`[Langfuse:${this.label}] called span.end() for id=${spanInfo.obj.id}`);
        }
        // event type: fire-and-forget
        this.spanMap.delete(spanId);
    }

    async export(spanData) {
        const trace = this.getOrCreateTrace(spanData.traceId, {
            channelId: spanData.attributes?.["openclaw.channel.id"],
        });
        // Use agent span as parent when available
        const parent = this._getParent(spanData.traceId);
        const startTime = new Date(spanData.startTime);
        if (spanData.type === "model") {
            const usageInput = spanData.attributes?.["gen_ai.usage.input_tokens"];
            const usageOutput = spanData.attributes?.["gen_ai.usage.output_tokens"];
            const generation = parent.generation({
                name: spanData.name,
                model: spanData.attributes?.["gen_ai.request.model"] || "unknown",
                startTime, metadata: spanData.attributes,
                input: parseInput(spanData.attributes),
                output: parseOutput(spanData.attributes),
            });
            if (usageInput !== undefined || usageOutput !== undefined) {
                const usage = {};
                if (usageInput !== undefined) usage.promptTokens = usageInput;
                if (usageOutput !== undefined) usage.completionTokens = usageOutput;
                if (usageInput !== undefined && usageOutput !== undefined) usage.totalTokens = usageInput + usageOutput;
                generation.update({ usage });
            }
            generation.end();
        } else if (spanData.type === "tool") {
            // Use "tool-create" event type directly for TOOL observation type
            // TOOL type is required for Langfuse graph/DAG rendering
            const toolId = crypto.randomUUID();
            this.langfuse.enqueue("tool-create", {
                id: toolId,
                traceId: parent.traceId,
                parentObservationId: parent.observationId || undefined,
                name: spanData.name,
                startTime,
                endTime: new Date(),
                metadata: spanData.attributes,
                input: spanData.attributes?.["gen_ai.tool.call.arguments"],
                output: spanData.attributes?.["gen_ai.tool.call.result"],
                environment: "default",
            });
        } else {
            trace.event({ name: spanData.name, startTime, metadata: spanData.attributes });
        }
    }

    endTrace() { this.traceMap.clear(); this.spanMap.clear(); this.agentSpanMap.clear(); }
    async flush() { await this.langfuse.flushAsync(); }
    async dispose() { await this.langfuse.flushAsync(); await this.langfuse.shutdownAsync(); this.traceMap.clear(); this.spanMap.clear(); }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function parseInput(attributes) {
    if (!attributes) return undefined;
    const input = {};
    if (attributes["gen_ai.input.messages"]) {
        try { input.messages = JSON.parse(attributes["gen_ai.input.messages"]); } catch { input.messages = attributes["gen_ai.input.messages"]; }
    }
    if (attributes["gen_ai.system_instructions"]) {
        try { input.systemPrompt = JSON.parse(attributes["gen_ai.system_instructions"]); } catch { input.systemPrompt = attributes["gen_ai.system_instructions"]; }
    }
    return Object.keys(input).length > 0 ? input : undefined;
}

function parseOutput(attributes) {
    if (!attributes) return undefined;
    const output = {};
    if (attributes["gen_ai.output.messages"]) {
        try { output.messages = JSON.parse(attributes["gen_ai.output.messages"]); } catch { output.messages = attributes["gen_ai.output.messages"]; }
    }
    return Object.keys(output).length > 0 ? output : undefined;
}

// ---------------------------------------------------------------------------
// Multi-target facade — delegates every call to all SingleTargetExporters
// ---------------------------------------------------------------------------
export class LangfuseExporter {
    constructor(api, config) {
        this.api = api;
        this.config = config;
        this.targets = [];

        // Build target list: support both single config and targets array
        const targetConfigs = config.targets || [
            { publicKey: config.publicKey, secretKey: config.secretKey, baseUrl: config.baseUrl, debug: config.debug },
        ];

        for (const t of targetConfigs) {
            if (!t.publicKey || !t.secretKey) continue;
            const label = t.name || t.baseUrl || "default";
            this.targets.push(new SingleTargetExporter(api, t, label));
            api.logger.info(`[Langfuse] Target added: ${label}`);
        }

        api.logger.info(`[Langfuse] Plugin initialized with ${this.targets.length} target(s)`);
    }

    getOrCreateTrace(traceId, metadata) {
        // Return the first target's trace (used by caller for span creation)
        // All targets are synced via startSpan/export/endSpanById
        return this.targets[0]?.getOrCreateTrace(traceId, metadata);
    }

    async startSpan(spanData, customSpanId) {
        await Promise.allSettled(this.targets.map(t => t.startSpan(spanData, customSpanId)));
    }

    updateTrace(traceId, updates) {
        for (const t of this.targets) t.updateTrace(traceId, updates);
    }

    endSpanById(spanId, endTime, additionalAttrs, output, _input) {
        for (const t of this.targets) t.endSpanById(spanId, endTime, additionalAttrs, output, _input);
    }

    async export(spanData) {
        await Promise.allSettled(this.targets.map(t => t.export(spanData)));
    }

    endTrace() {
        for (const t of this.targets) t.endTrace();
    }

    async flush() {
        await Promise.allSettled(this.targets.map(t => t.flush()));
        if (this.config.debug) this.api.logger.debug(`[Langfuse] Flushed ${this.targets.length} target(s)`);
    }

    async dispose() {
        await Promise.allSettled(this.targets.map(t => t.dispose()));
        this.api.logger.info(`[Langfuse] Plugin disposed (${this.targets.length} targets)`);
    }

    // Keep backward compat for callers that use parseInput/parseOutput directly
    parseInput(attributes) { return parseInput(attributes); }
    parseOutput(attributes) { return parseOutput(attributes); }
}

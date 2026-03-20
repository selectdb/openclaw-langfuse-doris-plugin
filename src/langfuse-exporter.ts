import { Langfuse } from "langfuse";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Direct fetch using node:http/https — completely bypasses global-agent proxy
// patching on globalThis.fetch. Same approach as @opentelemetry/otlp-exporter-base
// which uses http.request() directly to avoid proxy interference.
// ---------------------------------------------------------------------------
const directHttpAgent = new http.Agent({ keepAlive: true });
const directHttpsAgent = new https.Agent({ keepAlive: true });

function directFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const parsedUrl = new URL(typeof url === "string" ? url : url.toString());
  const isHttps = parsedUrl.protocol === "https:";
  const lib = isHttps ? https : http;
  const agent = isHttps ? directHttpsAgent : directHttpAgent;

  return new Promise((resolve, reject) => {
    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string | number> = {};
    if (init.headers) {
      if (typeof (init.headers as any).forEach === "function") {
        (init.headers as any).forEach((v: string, k: string) => { headers[k] = v; });
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }
    const body = init.body ?? null;
    if (body && !headers["content-length"] && typeof body === "string") {
      headers["content-length"] = Buffer.byteLength(body);
    }

    const req = lib.request(parsedUrl, { method, headers: headers as any, agent, timeout: 30000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf-8");
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage || "",
          headers: new Headers(
            Object.entries(res.headers)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!] as [string, string])
          ),
          text: () => Promise.resolve(text),
          json: () => Promise.resolve(JSON.parse(text)),
        } as any);
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

export interface LangfusePluginConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  debug?: boolean;
}

export interface PluginApi {
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
    debug: (msg: string) => void;
  };
}

interface SpanData {
  name: string;
  type: string;
  startTime: number;
  endTime?: number;
  attributes?: Record<string, any>;
  input?: any;
  output?: any;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export class LangfuseExporter {
  private config: LangfusePluginConfig;
  private api: PluginApi;
  private langfuse: Langfuse;
  private traceMap = new Map<string, any>();
  private spanMap = new Map<string, any>();
  private initialized = false;

  constructor(api: PluginApi, config: LangfusePluginConfig) {
    this.api = api;
    this.config = config;

    this.langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl || "https://cloud.langfuse.com",
      requestTimeout: 30000,
    });
    // Monkey-patch fetch to use node:http directly, bypassing global-agent proxy
    (this.langfuse as any).fetch = directFetch;

    this.initialized = true;
    if (config.debug) {
      this.api.logger.debug(`[Langfuse] Initialized with baseUrl: ${config.baseUrl || "https://cloud.langfuse.com"}`);
    }
    this.api.logger.info(`[Langfuse] Plugin initialized`);
  }

  /**
   * Get or create a Langfuse trace for the given traceId
   */
  getOrCreateTrace(traceId: string, metadata: Record<string, any> = {}): any {
    let trace = this.traceMap.get(traceId);
    if (!trace) {
      trace = this.langfuse.trace({
        name: `openclaw-${traceId.slice(0, 8)}`,
        metadata: {
          ...metadata,
          source: "openclaw-plugin",
        },
      });
      this.traceMap.set(traceId, trace);
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Created trace: ${traceId}`);
      }
    }
    return trace;
  }

  /**
   * Start a root or agent span
   */
  async startSpan(spanData: SpanData, customSpanId?: string): Promise<void> {
    const trace = this.getOrCreateTrace(spanData.traceId, {
      channelId: spanData.attributes?.["openclaw.channel.id"],
    });

    const spanId = customSpanId || spanData.spanId;
    const startTime = new Date(spanData.startTime);

    if (spanData.type === "entry" || !spanData.parentSpanId) {
      // Root span - create a trace-level event
      const event = trace.event({
        name: spanData.name,
        startTime,
        metadata: spanData.attributes,
      });
      this.spanMap.set(spanId, { type: "event", obj: event, trace });
    } else if (spanData.type === "agent") {
      // Agent span - use span
      const span = trace.span({
        name: spanData.name,
        startTime,
        metadata: spanData.attributes,
        input: spanData.input,
      });
      this.spanMap.set(spanId, { type: "span", obj: span, trace });
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Started agent span: ${spanData.name}`);
      }
    } else if (spanData.type === "model") {
      // LLM generation - use generation
      const generation = trace.generation({
        name: spanData.name,
        model: spanData.attributes?.["gen_ai.request.model"] || "unknown",
        startTime,
        metadata: spanData.attributes,
        input: this.parseInput(spanData.attributes),
        output: this.parseOutput(spanData.attributes),
      });
      this.spanMap.set(spanId, { type: "generation", obj: generation, trace });
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Started generation: ${spanData.name}`);
      }
    }
  }

  /**
   * End a span by ID
   */
  endSpanById(
    spanId: string,
    endTime: number,
    additionalAttrs?: Record<string, any>,
    output?: any,
    _input?: any
  ): void {
    const spanInfo = this.spanMap.get(spanId);
    if (!spanInfo) return;

    const endDate = new Date(endTime);

    if (spanInfo.type === "generation" && spanInfo.obj) {
      // Update generation with output and usage
      const generation = spanInfo.obj;
      if (additionalAttrs) {
        (generation as any).update({
          metadata: additionalAttrs,
          output: output || this.parseOutput(additionalAttrs),
        });
      }
      (generation as any).end();
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Ended generation: spanId=${spanId}`);
      }
    } else if (spanInfo.type === "span" && spanInfo.obj) {
      const span = spanInfo.obj;
      if (additionalAttrs) {
        (span as any).update({
          metadata: additionalAttrs,
          output: output,
        });
      }
      (span as any).end();
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Ended span: spanId=${spanId}`);
      }
    } else if (spanInfo.type === "event" && spanInfo.obj) {
      // Langfuse events are fire-and-forget, no .end() or .update()
    }

    this.spanMap.delete(spanId);
  }

  /**
   * Export a short-lived span (fire-and-forget)
   */
  async export(spanData: SpanData): Promise<void> {
    const trace = this.getOrCreateTrace(spanData.traceId, {
      channelId: spanData.attributes?.["openclaw.channel.id"],
    });

    const startTime = new Date(spanData.startTime);
    const endTime = spanData.endTime ? new Date(spanData.endTime) : new Date();

    if (spanData.type === "model") {
      // LLM generation
      const usageInput = spanData.attributes?.["gen_ai.usage.input_tokens"];
      const usageOutput = spanData.attributes?.["gen_ai.usage.output_tokens"];

      const generation = trace.generation({
        name: spanData.name,
        model: spanData.attributes?.["gen_ai.request.model"] || "unknown",
        startTime,
        metadata: spanData.attributes,
        input: this.parseInput(spanData.attributes),
        output: this.parseOutput(spanData.attributes),
      });

      // Update with usage if available
      if (usageInput !== undefined || usageOutput !== undefined) {
        const usage: Record<string, number> = {};
        if (usageInput !== undefined) usage.promptTokens = usageInput;
        if (usageOutput !== undefined) usage.completionTokens = usageOutput;
        if (usageInput !== undefined && usageOutput !== undefined) {
          usage.totalTokens = usageInput + usageOutput;
        }
        (generation as any).update({ usage });
      }

      (generation as any).end();
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Exported generation: ${spanData.name}`);
      }
    } else if (spanData.type === "tool") {
      // Tool call span
      const span = trace.span({
        name: spanData.name,
        startTime,
        metadata: spanData.attributes,
        input: spanData.attributes?.["gen_ai.tool.call.arguments"],
        output: spanData.attributes?.["gen_ai.tool.call.result"],
      });
      (span as any).end();
      if (this.config.debug) {
        this.api.logger.debug(`[Langfuse] Exported tool span: ${spanData.name}`);
      }
    } else if (spanData.type === "session" || spanData.type === "gateway") {
      // Session/gateway events (fire-and-forget, no .end())
      trace.event({
        name: spanData.name,
        startTime,
        metadata: spanData.attributes,
      });
    } else {
      // Default to event (fire-and-forget, no .end())
      trace.event({
        name: spanData.name,
        startTime,
        metadata: spanData.attributes,
      });
    }
  }

  /**
   * End the current trace
   */
  endTrace(): void {
    this.traceMap.clear();
    this.spanMap.clear();
  }

  /**
   * Flush pending data to Langfuse
   */
  async flush(): Promise<void> {
    await this.langfuse.flushAsync();
    if (this.config.debug) {
      this.api.logger.debug(`[Langfuse] Flushed`);
    }
  }

  /**
   * Dispose and shutdown
   */
  async dispose(): Promise<void> {
    await this.langfuse.flushAsync();
    await this.langfuse.shutdownAsync();
    this.traceMap.clear();
    this.spanMap.clear();
    this.api.logger.info(`[Langfuse] Plugin disposed`);
  }

  /**
   * Parse input from attributes
   */
  private parseInput(attributes?: Record<string, any>): any {
    if (!attributes) return undefined;

    const input: Record<string, any> = {};

    if (attributes["gen_ai.input.messages"]) {
      try {
        input.messages = JSON.parse(attributes["gen_ai.input.messages"]);
      } catch {
        input.messages = attributes["gen_ai.input.messages"];
      }
    }

    if (attributes["gen_ai.system_instructions"]) {
      try {
        input.systemPrompt = JSON.parse(attributes["gen_ai.system_instructions"]);
      } catch {
        input.systemPrompt = attributes["gen_ai.system_instructions"];
      }
    }

    return Object.keys(input).length > 0 ? input : undefined;
  }

  /**
   * Parse output from attributes
   */
  private parseOutput(attributes?: Record<string, any>): any {
    if (!attributes) return undefined;

    const output: Record<string, any> = {};

    if (attributes["gen_ai.output.messages"]) {
      try {
        output.messages = JSON.parse(attributes["gen_ai.output.messages"]);
      } catch {
        output.messages = attributes["gen_ai.output.messages"];
      }
    }

    return Object.keys(output).length > 0 ? output : undefined;
  }
}

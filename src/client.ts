import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import type {
  HelloData,
  PromptOptions,
  PromptResult,
  ZotClientOptions,
  ZotEvent,
  ZotMessage,
  ZotModelInfo,
  ZotResponse,
  ZotState,
} from "./types.js";
import { ZotRpcError } from "./types.js";

type Pending = {
  command: string;
  resolve: (response: ZotResponse) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type CommandPayload = { type: string; id?: string; [key: string]: unknown };

export class ZotClient extends EventEmitter {
  private readonly options: ZotClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private eventQueue: ZotEvent[] = [];
  private eventWaiters: Array<(event: ZotEvent) => void> = [];
  private closed = false;
  private startPromise?: Promise<void>;

  constructor(options: ZotClientOptions = {}) {
    super();
    this.options = options;
  }

  get process(): ChildProcessWithoutNullStreams | undefined {
    return this.child;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner();
    return this.startPromise;
  }

  async hello(): Promise<HelloData> {
    return this.request<HelloData>({ type: "hello", token: this.options.rpcToken });
  }

  async ping(): Promise<{ pong: true }> {
    return this.request<{ pong: true }>({ type: "ping" });
  }

  async prompt(message: string, options: PromptOptions = {}): Promise<PromptResult> {
    const events: ZotEvent[] = [];
    let text = "";

    for await (const event of this.promptStream(message, options)) {
      events.push(event);
      if (event.type === "text_delta") text += event.delta;
    }

    return { text, events };
  }

  async *promptStream(message: string, options: PromptOptions = {}): AsyncGenerator<ZotEvent> {
    await this.request<{ started: true }>({ type: "prompt", message, images: options.images ?? [] });

    while (true) {
      const event = await this.nextEvent();
      yield event;
      if (event.type === "done") return;
    }
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async compact(): Promise<string> {
    await this.request<{ started: true }>({ type: "compact" });
    let summary = "";

    while (true) {
      const event = await this.nextEvent();
      this.emit("compact_event", event);
      if (event.type === "compact_done") summary = String(event.summary ?? "");
      if (event.type === "done") return summary;
    }
  }

  async getState(): Promise<ZotState> {
    return this.request<ZotState>({ type: "get_state" });
  }

  async getMessages(): Promise<ZotMessage[]> {
    const data = await this.request<{ messages: ZotMessage[] }>({ type: "get_messages" });
    return data.messages;
  }

  async clear(): Promise<void> {
    await this.request({ type: "clear" });
  }

  async setModel(model: string): Promise<void> {
    await this.request({ type: "set_model", model });
  }

  async getModels(): Promise<ZotModelInfo[]> {
    const data = await this.request<{ models: ZotModelInfo[] }>({ type: "get_models" });
    return data.models;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new ZotRpcError("zot rpc process closed"));
    }
    this.pending.clear();
    this.lines?.close();
    this.child?.stdin.end();
    this.child?.kill();
  }

  private async startInner(): Promise<void> {
    if (this.child) return;

    const args = this.buildArgs();
    const child = spawn(this.options.binary ?? process.env.ZOT_BINARY ?? "zot", args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new ZotRpcError(`zot rpc exited with code ${code ?? "null"} and signal ${signal ?? "null"}`));
      this.emit("exit", code, signal);
    });

    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    if (this.options.rpcToken || this.options.env?.ZOTCORE_RPC_TOKEN) {
      await this.requestRaw<HelloData>({ type: "hello", token: this.options.rpcToken });
    }
  }

  private buildArgs(): string[] {
    const args = ["rpc"];
    const push = (flag: string, value?: string | number | boolean): void => {
      if (value === undefined || value === false) return;
      args.push(flag);
      if (value !== true) args.push(String(value));
    };

    push("--provider", this.options.provider);
    push("--model", this.options.model);
    push("--cwd", this.options.cwd);
    push("--api-key", this.options.apiKey);
    push("--base-url", this.options.baseUrl);
    push("--system-prompt", this.options.systemPrompt);
    const appended = Array.isArray(this.options.appendSystemPrompt)
      ? this.options.appendSystemPrompt
      : this.options.appendSystemPrompt
        ? [this.options.appendSystemPrompt]
        : [];
    for (const text of appended) push("--append-system-prompt", text);
    push("--reasoning", this.options.reasoning);
    push("--max-steps", this.options.maxSteps);
    push("--no-tools", this.options.noTools);
    if (this.options.tools?.length) push("--tools", this.options.tools.join(","));

    return args;
  }

  private async request<T = unknown>(payload: CommandPayload): Promise<T> {
    await this.start();
    return this.requestRaw<T>(payload);
  }

  private async requestRaw<T = unknown>(payload: CommandPayload): Promise<T> {
    if (!this.child || this.closed) throw new ZotRpcError("zot rpc process is not running");

    const id = String(this.nextId++);
    const command = payload.type;
    const frame = { ...payload, id };

    const response = await new Promise<ZotResponse>((resolve, reject) => {
      const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZotRpcError(`zot rpc command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timeout });
      this.child?.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });

    if (!response.success) {
      throw new ZotRpcError(response.error ?? `zot rpc command failed: ${command}`, response);
    }
    return response.data as T;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let frame: ZotResponse | ZotEvent;
    try {
      frame = JSON.parse(line) as ZotResponse | ZotEvent;
    } catch (error) {
      this.emit("parse_error", error, line);
      return;
    }

    if (frame.type === "response" && "success" in frame) {
      const response = frame as ZotResponse;
      const id = response.id;
      if (!id) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve(response);
      return;
    }

    const event = frame as ZotEvent;
    this.emit("event", event);
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter(event);
    else this.eventQueue.push(event);
  }

  private nextEvent(): Promise<ZotEvent> {
    const event = this.eventQueue.shift();
    if (event) return Promise.resolve(event);
    if (this.closed) return Promise.reject(new ZotRpcError("zot rpc process closed"));
    return new Promise((resolve) => this.eventWaiters.push(resolve));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function createZotClient(options: ZotClientOptions = {}): Promise<ZotClient> {
  const client = new ZotClient(options);
  await client.start();
  return client;
}

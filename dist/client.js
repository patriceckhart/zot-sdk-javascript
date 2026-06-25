import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { ZotRpcError } from "./types.js";
const subscriptionProviders = new Set(["anthropic", "openai-codex", "kimi", "github-copilot"]);
export class ZotClient extends EventEmitter {
    options;
    child;
    lines;
    nextId = 1;
    pending = new Map();
    eventQueue = [];
    eventWaiters = [];
    closed = false;
    startPromise;
    constructor(options = {}) {
        super();
        this.options = options;
    }
    get process() {
        return this.child;
    }
    async start() {
        if (this.startPromise)
            return this.startPromise;
        this.startPromise = this.startInner();
        return this.startPromise;
    }
    async hello() {
        return this.request({ type: "hello", token: this.options.rpcToken });
    }
    async ping() {
        return this.request({ type: "ping" });
    }
    async prompt(message, options = {}) {
        const events = [];
        let text = "";
        for await (const event of this.promptStream(message, options)) {
            events.push(event);
            if (event.type === "text_delta")
                text += event.delta;
        }
        return { text, events };
    }
    async *promptStream(message, options = {}) {
        await this.request({ type: "prompt", message, images: options.images ?? [] });
        while (true) {
            const event = await this.nextEvent();
            yield event;
            if (event.type === "done")
                return;
        }
    }
    async abort() {
        await this.request({ type: "abort" });
    }
    async compact() {
        await this.request({ type: "compact" });
        let summary = "";
        while (true) {
            const event = await this.nextEvent();
            this.emit("compact_event", event);
            if (event.type === "compact_done")
                summary = String(event.summary ?? "");
            if (event.type === "done")
                return summary;
        }
    }
    async getState() {
        return this.request({ type: "get_state" });
    }
    async getMessages() {
        const data = await this.request({ type: "get_messages" });
        return data.messages;
    }
    async clear() {
        await this.request({ type: "clear" });
    }
    async setModel(model) {
        await this.request({ type: "set_model", model });
    }
    async getModels() {
        const data = await this.request({ type: "get_models" });
        return data.models;
    }
    close() {
        this.closed = true;
        for (const pending of this.pending.values()) {
            if (pending.timeout)
                clearTimeout(pending.timeout);
            pending.reject(new ZotRpcError("zot rpc process closed"));
        }
        this.pending.clear();
        this.lines?.close();
        this.child?.stdin.end();
        this.child?.kill();
    }
    async startInner() {
        if (this.child)
            return;
        const args = this.buildArgs();
        const child = spawn(this.options.binary ?? process.env.ZOT_BINARY ?? "zot", args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
        child.on("error", (error) => this.failAll(error));
        child.on("exit", (code, signal) => {
            this.closed = true;
            this.failAll(new ZotRpcError(`zot rpc exited with code ${code ?? "null"} and signal ${signal ?? "null"}`));
            this.emit("exit", code, signal);
        });
        this.lines = createInterface({ input: child.stdout });
        this.lines.on("line", (line) => this.handleLine(line));
        if (this.options.rpcToken || this.options.env?.ZOTCORE_RPC_TOKEN) {
            await this.requestRaw({ type: "hello", token: this.options.rpcToken });
        }
    }
    buildArgs() {
        this.validateAuthOptions();
        const args = ["rpc"];
        const push = (flag, value) => {
            if (value === undefined || value === false)
                return;
            args.push(flag);
            if (value !== true)
                args.push(String(value));
        };
        push("--provider", this.options.provider);
        push("--model", this.options.model);
        push("--cwd", this.options.cwd);
        if (this.options.auth !== "subscription")
            push("--api-key", this.options.apiKey);
        push("--base-url", this.options.baseUrl);
        push("--system-prompt", this.options.systemPrompt);
        const appended = Array.isArray(this.options.appendSystemPrompt)
            ? this.options.appendSystemPrompt
            : this.options.appendSystemPrompt
                ? [this.options.appendSystemPrompt]
                : [];
        for (const text of appended)
            push("--append-system-prompt", text);
        push("--reasoning", this.options.reasoning);
        push("--max-steps", this.options.maxSteps);
        push("--no-tools", this.options.noTools);
        if (this.options.tools?.length)
            push("--tools", this.options.tools.join(","));
        return args;
    }
    validateAuthOptions() {
        if (this.options.auth === "apiKey" && !this.options.apiKey) {
            throw new ZotRpcError("ZotClient auth:'apiKey' requires apiKey");
        }
        if (this.options.auth !== "subscription")
            return;
        const provider = this.options.provider;
        if (!provider) {
            throw new ZotRpcError("ZotClient auth:'subscription' requires provider");
        }
        if (!subscriptionProviders.has(provider)) {
            throw new ZotRpcError(`ZotClient auth:'subscription' supports anthropic, openai-codex, kimi, and github-copilot, not ${provider}`);
        }
        if (this.options.apiKey) {
            throw new ZotRpcError("ZotClient auth:'subscription' cannot be combined with apiKey");
        }
    }
    async request(payload) {
        await this.start();
        return this.requestRaw(payload);
    }
    async requestRaw(payload) {
        if (!this.child || this.closed)
            throw new ZotRpcError("zot rpc process is not running");
        const id = String(this.nextId++);
        const command = payload.type;
        const frame = { ...payload, id };
        const response = await new Promise((resolve, reject) => {
            const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new ZotRpcError(`zot rpc command timed out: ${command}`));
            }, timeoutMs);
            this.pending.set(id, { command, resolve, reject, timeout });
            this.child?.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
                if (!error)
                    return;
                this.pending.delete(id);
                clearTimeout(timeout);
                reject(error);
            });
        });
        if (!response.success) {
            throw new ZotRpcError(response.error ?? `zot rpc command failed: ${command}`, response);
        }
        return response.data;
    }
    handleLine(line) {
        if (!line.trim())
            return;
        let frame;
        try {
            frame = JSON.parse(line);
        }
        catch (error) {
            this.emit("parse_error", error, line);
            return;
        }
        if (frame.type === "response" && "success" in frame) {
            const response = frame;
            const id = response.id;
            if (!id)
                return;
            const pending = this.pending.get(id);
            if (!pending)
                return;
            this.pending.delete(id);
            if (pending.timeout)
                clearTimeout(pending.timeout);
            pending.resolve(response);
            return;
        }
        const event = frame;
        this.emit("event", event);
        const waiter = this.eventWaiters.shift();
        if (waiter)
            waiter(event);
        else
            this.eventQueue.push(event);
    }
    nextEvent() {
        const event = this.eventQueue.shift();
        if (event)
            return Promise.resolve(event);
        if (this.closed)
            return Promise.reject(new ZotRpcError("zot rpc process closed"));
        return new Promise((resolve) => this.eventWaiters.push(resolve));
    }
    failAll(error) {
        for (const pending of this.pending.values()) {
            if (pending.timeout)
                clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
export async function createZotClient(options = {}) {
    const client = new ZotClient(options);
    await client.start();
    return client;
}
//# sourceMappingURL=client.js.map
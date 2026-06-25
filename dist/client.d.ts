import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { HelloData, PromptOptions, PromptResult, ZotClientOptions, ZotEvent, ZotMessage, ZotModelInfo, ZotState } from "./types.js";
export declare class ZotClient extends EventEmitter {
    private readonly options;
    private child?;
    private lines?;
    private nextId;
    private pending;
    private eventQueue;
    private eventWaiters;
    private closed;
    private startPromise?;
    constructor(options?: ZotClientOptions);
    get process(): ChildProcessWithoutNullStreams | undefined;
    start(): Promise<void>;
    hello(): Promise<HelloData>;
    ping(): Promise<{
        pong: true;
    }>;
    prompt(message: string, options?: PromptOptions): Promise<PromptResult>;
    promptStream(message: string, options?: PromptOptions): AsyncGenerator<ZotEvent>;
    abort(): Promise<void>;
    compact(): Promise<string>;
    getState(): Promise<ZotState>;
    getMessages(): Promise<ZotMessage[]>;
    clear(): Promise<void>;
    setModel(model: string): Promise<void>;
    getModels(): Promise<ZotModelInfo[]>;
    close(): void;
    private startInner;
    private buildArgs;
    private validateAuthOptions;
    private request;
    private requestRaw;
    private handleLine;
    private nextEvent;
    private failAll;
}
export declare function createZotClient(options?: ZotClientOptions): Promise<ZotClient>;
//# sourceMappingURL=client.d.ts.map
export class ZotRpcError extends Error {
    response;
    constructor(message, response) {
        super(message);
        this.name = "ZotRpcError";
        if (response)
            this.response = response;
    }
}
//# sourceMappingURL=types.js.map
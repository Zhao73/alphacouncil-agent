/** JSON-RPC 2.0 reserved error codes. */
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/**
 * An error that already knows which JSON-RPC code it should surface as.
 *
 * Without this the RPC layer has to guess, and it used to guess INVALID_PARAMS for
 * everything -- so a missing run directory or a failed network fetch was reported to
 * the host as "you passed bad parameters".
 */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export const invalidParams = (message, data) => new RpcError(RpcCode.INVALID_PARAMS, message, data);
export const internalError = (message, data) => new RpcError(RpcCode.INTERNAL_ERROR, message, data);
export const methodNotFound = (message, data) => new RpcError(RpcCode.METHOD_NOT_FOUND, message, data);

/** Map any thrown value to a JSON-RPC error payload. */
export function toRpcError(error) {
  const debug = process.env.ALPHACOUNCIL_DEBUG === "1";
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined || debug ? { data: { ...(error.data ?? {}), ...(debug ? { stack: error.stack } : {}) } } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: RpcCode.INTERNAL_ERROR,
    message,
    ...(debug && error instanceof Error ? { data: { stack: error.stack } } : {}),
  };
}

/**
 * Synthetic Lambda events.
 *
 * The Function URL builder produces the payload format 2.0 envelope AWS sends,
 * because the handler's whole discrimination rests on that envelope's shape:
 * a test that invented a simpler one would prove nothing about production.
 */

export interface FunctionUrlEventOptions {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly rawQueryString?: string;
}

export function functionUrlEvent(options: FunctionUrlEventOptions): unknown {
  return {
    version: "2.0",
    rawPath: options.path,
    rawQueryString: options.rawQueryString ?? "",
    headers: { host: "example.lambda-url.us-east-1.on.aws", ...options.headers },
    requestContext: {
      domainName: "example.lambda-url.us-east-1.on.aws",
      http: {
        method: options.method,
        path: options.path,
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.7",
      },
    },
    ...(options.body === undefined ? {} : { body: options.body, isBase64Encoded: false }),
  };
}

export function scheduledEvent(detailType = "Scheduled Invocation"): unknown {
  return {
    source: "aws.scheduler",
    "detail-type": detailType,
    time: "2026-08-17T09:00:00Z",
  };
}

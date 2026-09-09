type LogValue = boolean | number | string | null | undefined;

type RequestReference = {
  requestId: string;
};

type RunReference = {
  generation: number;
  id: string;
};

type LogFields = Record<string, LogValue>;

export type LogContext = {
  request?: RequestReference;
  run?: RunReference;
};

export class ContextLogger {
  constructor(private readonly component: string) {}

  error(event: string, context?: LogContext, fields?: LogFields): void {
    this.emit("error", event, context, fields);
  }

  info(event: string, context?: LogContext, fields?: LogFields): void {
    this.emit("info", event, context, fields);
  }

  warn(event: string, context?: LogContext, fields?: LogFields): void {
    this.emit("warn", event, context, fields);
  }

  private emit(
    level: "error" | "info" | "warn",
    event: string,
    context: LogContext = {},
    fields: LogFields = {},
  ): void {
    console[level](
      `cloud-gaming ${event}`,
      compact({
        component: this.component,
        generation: context.run?.generation,
        requestId: context.request?.requestId,
        runId: context.run?.id,
        ...fields,
      }),
    );
  }
}

function compact(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

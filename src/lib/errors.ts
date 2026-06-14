export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExpectedFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ExpectedFailure";
    this.exitCode = exitCode;
  }
}

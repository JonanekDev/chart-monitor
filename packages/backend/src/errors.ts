export class AppError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ConfigError extends AppError {}
export class RepoAccessError extends AppError {}
export class ArgoCdParseError extends AppError {}
export class HelmResolutionError extends AppError {}
export class TrivyScanError extends AppError {}
export class ScanNotFoundError extends AppError {}

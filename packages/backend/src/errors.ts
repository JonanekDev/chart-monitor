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
export class GithubAccessError extends AppError {}
export class ArgoCdParseError extends AppError {}
export class HelmResolutionError extends AppError {}
export class ScanNotFoundError extends AppError {}

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
/** A registry or Helm repo refused the login (401/403), or answered 404 although we sent one (many
 * hide what a login may not see): worth a warning, unlike a missing tag list */
export class RegistryAuthError extends AppError {}
export class ScanNotFoundError extends AppError {}
export class NotFoundError extends AppError {}
/** Bad input that passed the schema but not a semantic check (e.g. an invalid cron expression) */
export class ValidationError extends AppError {}
export class ConflictError extends AppError {}

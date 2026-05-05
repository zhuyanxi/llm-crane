export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class SubprocessNotRunningError extends Error {
  constructor(processName: string) {
    super(`${processName} process is not running.`);
    this.name = 'SubprocessNotRunningError';
  }
}
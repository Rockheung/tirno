export class WandrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WandrError';
  }
}

export class SessionNotFound extends WandrError {
  constructor(name: string) {
    super(`Session '${name}' not found`);
    this.name = 'SessionNotFound';
  }
}

export class SessionAlreadyExists extends WandrError {
  constructor(name: string) {
    super(`Session '${name}' already exists`);
    this.name = 'SessionAlreadyExists';
  }
}

export class ChromeNotRunning extends WandrError {
  constructor(name: string, pid: number) {
    super(`Chrome for session '${name}' is not running (PID ${pid})`);
    this.name = 'ChromeNotRunning';
  }
}

export class NoActiveSession extends WandrError {
  constructor() {
    super('No active session. Use "wandr attach <name>" or "-s <name>"');
    this.name = 'NoActiveSession';
  }
}

export class PortUnavailable extends WandrError {
  constructor(port: number) {
    super(`Port ${port} is unavailable`);
    this.name = 'PortUnavailable';
  }
}

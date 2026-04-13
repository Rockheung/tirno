export class ChromuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromuxError';
  }
}

export class SessionNotFound extends ChromuxError {
  constructor(name: string) {
    super(`Session '${name}' not found`);
    this.name = 'SessionNotFound';
  }
}

export class SessionAlreadyExists extends ChromuxError {
  constructor(name: string) {
    super(`Session '${name}' already exists`);
    this.name = 'SessionAlreadyExists';
  }
}

export class ChromeNotRunning extends ChromuxError {
  constructor(name: string, pid: number) {
    super(`Chrome for session '${name}' is not running (PID ${pid})`);
    this.name = 'ChromeNotRunning';
  }
}

export class NoActiveSession extends ChromuxError {
  constructor() {
    super('No active session. Use "chromux attach <name>" or "-s <name>"');
    this.name = 'NoActiveSession';
  }
}

export class PortUnavailable extends ChromuxError {
  constructor(port: number) {
    super(`Port ${port} is unavailable`);
    this.name = 'PortUnavailable';
  }
}

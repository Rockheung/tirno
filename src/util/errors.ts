export class TirnoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TirnoError';
  }
}

export class SessionNotFound extends TirnoError {
  constructor(name: string) {
    super(`Session '${name}' not found`);
    this.name = 'SessionNotFound';
  }
}

export class SessionAlreadyExists extends TirnoError {
  constructor(name: string) {
    super(`Session '${name}' already exists`);
    this.name = 'SessionAlreadyExists';
  }
}

export class ChromeNotRunning extends TirnoError {
  constructor(name: string, pid: number) {
    super(`Chrome for session '${name}' is not running (PID ${pid})`);
    this.name = 'ChromeNotRunning';
  }
}

export class NoActiveSession extends TirnoError {
  constructor() {
    super('No active session. Use "tirno attach <name>" or "-s <name>"');
    this.name = 'NoActiveSession';
  }
}

export class PortUnavailable extends TirnoError {
  constructor(port: number) {
    super(`Port ${port} is unavailable`);
    this.name = 'PortUnavailable';
  }
}

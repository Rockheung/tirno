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

/**
 * Something is listening, but observation says it is not this session's chrome.
 * The message names the actual owner — a bare "cannot connect" would invite the
 * user to retry or "clean up" the very process we are protecting.
 */
export class SessionNotOwned extends TirnoError {
  constructor(name: string, port: number | null, reason: string) {
    super(`Refusing to connect to session '${name}'${port === null ? '' : ` (port ${port})`}: ${reason}`);
    this.name = 'SessionNotOwned';
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

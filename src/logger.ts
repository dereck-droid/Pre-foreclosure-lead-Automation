/**
 * Simple logger that prefixes every message with a timestamp.
 * Outputs to the console — when deployed, Railway captures these automatically.
 */

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function format(level: string, message: string, data?: unknown): string {
  const base = `[${timestamp()}] [${level}] ${message}`;
  if (data !== undefined) {
    return `${base} ${JSON.stringify(data, null, 2)}`;
  }
  return base;
}

export const log = {
  info(message: string, data?: unknown) {
    console.log(format('INFO', message, data));
  },

  warn(message: string, data?: unknown) {
    console.warn(format('WARN', message, data));
  },

  error(message: string, data?: unknown) {
    console.error(format('ERROR', message, data));
  },

  success(message: string, data?: unknown) {
    console.log(format('OK', message, data));
  },

  step(stepNumber: number, message: string) {
    console.log(format('STEP', `[${stepNumber}] ${message}`));
  },
};

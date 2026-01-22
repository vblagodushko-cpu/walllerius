// Simple logger utility for client-side
export const logger = {
  error: (...args) => {
    console.error(...args);
  },
  warn: (...args) => {
    console.warn(...args);
  },
  info: (...args) => {
    console.info(...args);
  },
  debug: (...args) => {
    if (import.meta.env.DEV) {
      console.debug(...args);
    }
  },
  log: (...args) => {
    console.log(...args);
  }
};


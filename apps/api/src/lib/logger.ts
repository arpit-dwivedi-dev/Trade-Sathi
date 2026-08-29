export const logger = {
  info: (message: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", message, ...meta })),
  error: (message: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: "error", message, ...meta })),
};

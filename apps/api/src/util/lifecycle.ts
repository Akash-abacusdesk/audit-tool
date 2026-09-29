/** Process lifecycle flag shared by main.ts (sets it on SIGTERM) and /readyz (reports it), so load balancers drain us first. */
export const lifecycle = { draining: false };

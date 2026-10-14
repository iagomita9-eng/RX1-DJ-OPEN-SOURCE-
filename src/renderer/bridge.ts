import type { Api } from './types';
// Exposto pelo preload (contextBridge).
export const api: Api = (window as unknown as { api: Api }).api;

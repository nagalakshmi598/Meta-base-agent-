import axios from 'axios';
import type { Database, Schema, Message } from '../types';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 120000, // 2 min for slow AI queries
  headers: { 'Content-Type': 'application/json' }
});

// Global session-expired callback — set by App.tsx
export let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void) { onSessionExpired = fn; }

api.interceptors.response.use(
  res => res,
  err => {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return Promise.reject(new Error('Request timed out. The backend may be slow or down.'));
    }
    if (err.code === 'ERR_NETWORK' || err.message === 'Network Error') {
      return Promise.reject(new Error('Cannot reach the backend server. Make sure the backend is running on port 3001.'));
    }
    if (err.response?.status === 401 && err.response?.data?.reconnect) {
      onSessionExpired?.();
      return Promise.reject(new Error('Session expired. Please reconnect to Metabase.'));
    }
    const message = err.response?.data?.error || err.response?.data?.details || err.message || 'Request failed';
    return Promise.reject(new Error(message));
  }
);

export const authApi = {
  connect: (url: string, email: string, password: string) =>
    api.post('/auth/connect', { url, email, password }).then(r => r.data),
  autoConnect: (): Promise<{ success: boolean; url: string }> =>
    api.post('/auth/auto-connect', {}, { timeout: 30000 }).then(r => r.data),
  envStatus: (): Promise<{ configured: boolean; url: string | null; email: string | null }> =>
    api.get('/auth/env-status', { timeout: 5000 }).then(r => r.data),
  disconnect: () =>
    api.post('/auth/disconnect').then(r => r.data),
  status: (): Promise<{ connected: boolean; url: string | null; email: string | null; connectedAt: string | null }> =>
    api.get('/auth/status', { timeout: 5000 }).then(r => r.data)
};

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  owner: string;
  mine: boolean;
  messageCount: number;
  sharedWith: string[];
  hasLink: boolean;
}

export const chatApi = {
  save: (payload: { id?: string; title?: string; messages: any[] }): Promise<{ id: string; title: string; updatedAt: string; owner: string }> =>
    api.post('/chat/save', payload).then(r => r.data),
  list: (): Promise<{ chats: ChatSummary[]; me: string }> =>
    api.get('/chat/list').then(r => r.data),
  get: (id: string, token?: string): Promise<{ chat: ChatSummary & { messages: any[]; readOnly?: boolean } }> =>
    api.get(`/chat/${id}`, { params: token ? { token } : {} }).then(r => r.data),
  getShared: (token: string): Promise<{ chat: ChatSummary & { messages: any[]; readOnly?: boolean } }> =>
    api.get(`/chat/shared/${token}`).then(r => r.data),
  shareLink: (id: string): Promise<{ token: string; url: string }> =>
    api.post(`/chat/${id}/share-link`).then(r => r.data),
  revokeLink: (id: string): Promise<{ ok: boolean }> =>
    api.post(`/chat/${id}/revoke-link`).then(r => r.data),
  shareEmails: (id: string, emails: string[]): Promise<{ sharedWith: string[]; token: string; url: string }> =>
    api.post(`/chat/${id}/share-emails`, { emails }).then(r => r.data),
  unshareEmail: (id: string, email: string): Promise<{ sharedWith: string[] }> =>
    api.post(`/chat/${id}/unshare-email`, { email }).then(r => r.data),
  del: (id: string): Promise<{ deleted: boolean }> =>
    api.delete(`/chat/${id}`).then(r => r.data),
};

export const metabaseApi = {
  getDatabases: (): Promise<{ data: Database[] }> =>
    api.get('/metabase/databases').then(r => r.data),
  getDatabaseMetadata: (id: number): Promise<Schema> =>
    api.get(`/metabase/databases/${id}/metadata`).then(r => r.data),
  runSQL: (database_id: number, sql: string) =>
    api.post('/metabase/dataset', { database_id, sql }).then(r => r.data),
  getCards: () =>
    api.get('/metabase/cards').then(r => r.data),
  getDashboards: () =>
    api.get('/metabase/dashboards').then(r => r.data),
  getCollections: () =>
    api.get('/metabase/collections').then(r => r.data),
  scanDatabase: (database_id: number, tables: string[], engine: string): Promise<{ scanned: number; total: number }> =>
    api.post('/metabase/scan-database', { database_id, tables, engine }, { timeout: 300000 }).then(r => r.data),
  scanAllDatabases: (): Promise<{ started: boolean; databases: number; alreadyRunning?: boolean }> =>
    api.post('/metabase/scan-all-databases', {}, { timeout: 30000 }).then(r => r.data),
  scanAllStatus: (): Promise<{ status: 'idle' | 'scanning' | 'done' | 'error'; dbTotal?: number; dbDone?: number; collectionsScanned?: number; currentDb?: string }> =>
    api.get('/metabase/scan-all-status', { timeout: 8000 }).then(r => r.data)
};

export const aiApi = {
  config: (): Promise<{ ai_enabled: boolean; mode: 'ai' | 'sql'; message: string }> =>
    api.get('/ai/config', { timeout: 5000 }).then(r => r.data),
  query: (
    payload: {
      question?: string; sql?: string; database_id: number; schema?: Schema;
      history?: Pick<Message, 'role' | 'content'>[];
      images?: { mimeType: string; data: string }[];
    }
  ) =>
    api.post('/ai/query', payload).then(r => r.data),
  suggest: (schema: Schema): Promise<{ suggestions: string[] }> =>
    api.post('/ai/suggest', { schema }).then(r => r.data),
  explain: (sql: string, schema: Schema): Promise<{ explanation: string }> =>
    api.post('/ai/explain', { sql, schema }).then(r => r.data)
};

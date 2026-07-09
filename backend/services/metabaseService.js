import axios from 'axios';

export function createMetabaseClient(baseUrl) {
  const normalizedUrl = baseUrl.replace(/\/$/, '');

  const client = axios.create({
    baseURL: normalizedUrl,
    timeout: 60000,
    headers: { 'Content-Type': 'application/json' }
  });

  return {
    async authenticate(email, password) {
      const response = await client.post('/api/session', { username: email, password });
      return response.data.id;
    },

    async get(token, path, params = {}) {
      const response = await client.get(path, {
        headers: { 'X-Metabase-Session': token },
        params
      });
      return response.data;
    },

    async post(token, path, data = {}) {
      const response = await client.post(path, data, {
        headers: { 'X-Metabase-Session': token }
      });
      return response.data;
    },

    async delete(token, path) {
      const response = await client.delete(path, {
        headers: { 'X-Metabase-Session': token }
      });
      return response.data;
    }
  };
}

export function getClientFromSession(session) {
  if (!session.metabaseUrl || !session.metabaseToken) {
    const err = new Error('Not connected to Metabase. Please connect first.');
    err.statusCode = 401;
    throw err;
  }
  return {
    client: createMetabaseClient(session.metabaseUrl),
    token: session.metabaseToken
  };
}

export function formatSchemaForAI(schema) {
  if (!schema || !schema.tables) return 'No schema available';

  return schema.tables
    .filter(t => !t.visibility_type || t.visibility_type !== 'hidden')
    .map(table => {
      const fields = (table.fields || [])
        .map(f => {
          const type = f.base_type || f.effective_type || 'unknown';
          const semantic = f.semantic_type ? ` [${f.semantic_type}]` : '';
          const pk = f.semantic_type === 'type/PK' ? ' PRIMARY KEY' : '';
          const fk = f.semantic_type === 'type/FK' ? ' FOREIGN KEY' : '';
          return `  - ${f.name} (${type}${semantic}${pk}${fk})`;
        })
        .join('\n');
      return `TABLE: ${table.name}\n${fields || '  (no fields)'}`;
    })
    .join('\n\n');
}

export interface Database {
  id: number;
  name: string;
  engine: string;
  is_sample?: boolean;
  tables?: Table[];
}

export interface Table {
  id: number;
  name: string;
  display_name: string;
  schema: string;
  fields?: Field[];
  entity_type?: string;
}

export interface Field {
  id: number;
  name: string;
  display_name: string;
  base_type: string;
  effective_type?: string;
  semantic_type: string | null;
}

export interface QueryResults {
  cols: Column[];
  rows: (string | number | null)[][];
  row_count: number;
  native_form?: { query: string };
}

export interface Column {
  name: string;
  display_name?: string;
  base_type?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  mode?: 'ai' | 'sql';
  sql?: string;
  explanation?: string;
  tables_used?: string[];
  query_type?: string;
  is_mongo?: boolean;
  collection?: string;
  results?: QueryResults;
  answer?: string;
  timestamp: Date;
  loading?: boolean;
  executionTimeMs?: number;
  phase?: string;
  imagePreviews?: string[];
}

export interface ConnectionState {
  connected: boolean;
  url: string | null;
  connectedAt: string | null;
}

export interface Schema {
  id: number;
  name: string;
  engine?: string;
  tables: Table[];
}

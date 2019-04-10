import { DataQuery } from '@grafana/ui/src/types';

export interface LokiQuery extends DataQuery {
  expr: string;
  format?: LokiQueryResultFormats;
}

export type LokiQueryResultFormats = 'time_series' | 'logs';
